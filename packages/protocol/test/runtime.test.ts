import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClientClosed,
  ConnectionLost,
  ContractError,
  RequestTimeout,
  Runtime,
  ToolAwaitingApproval,
  ToolDenied,
  ToolFailed,
} from '../src/index.ts';
import { elapse, failed, failure, HandlerError, waitFor, withClient } from './mock-server.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const toolResult = (overrides: Record<string, unknown>) => ({
  ok: true,
  status: 'ok',
  callId: 'call-1',
  durationMs: 3,
  output: null,
  error: null,
  approval: null,
  deduped: false,
  ...overrides,
});

describe('Runtime.invoke', () => {
  it('sends the input and returns the decoded output', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.invoke', () => toolResult({ output: { changed: 2 } }));
      const output = await Runtime.invoke(client, 'journal.delete_tag', { id: 't1' }, { idempotencyKey: 'k1' });
      expect(output).toEqual({ changed: 2 });
      expect(server.requests('tools.invoke')[0]?.params).toEqual({
        name: 'journal.delete_tag',
        input: { id: 't1' },
        idempotencyKey: 'k1',
      });
    }));

  it('sends a deadline when the caller stamps one', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.invoke', () => toolResult({ output: { changed: 2 } }));
      await Runtime.invoke(client, 'journal.delete_tag', { id: 't1' }, { deadline: 99 });
      expect(server.requests('tools.invoke')[0]?.params).toEqual({
        name: 'journal.delete_tag',
        input: { id: 't1' },
        deadline: 99,
      });
    }));

  it('sends input as the socket does: an undefined property left out, an undefined in a list as null', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.invoke', (p) => {
        const { input } = p as { input: { key: string; value: unknown } };
        return toolResult({ output: { key: input.key, value: input.value, previous: null } });
      });
      const value = { panels: { 'chart-1': { id: 'chart-1', renderer: undefined } }, order: ['a', undefined] };
      const out = await Runtime.invoke(client, 'settings.set', { key: 'ui.dock', value: value as never });
      expect(server.requests('tools.invoke')[0]?.params).toEqual({
        name: 'settings.set',
        input: { key: 'ui.dock', value: { panels: { 'chart-1': { id: 'chart-1' } }, order: ['a', null] } },
      });
      expect(out.value).toEqual({ panels: { 'chart-1': { id: 'chart-1' } }, order: ['a', null] });
    }));

  it('types failures, denials and drafts awaiting approval', () =>
    withClient(async (client, server) => {
      const results = [
        toolResult({
          ok: false,
          status: 'error',
          error: { code: 'not_found', message: 'no tag t1', details: null, retryable: false },
        }),
        toolResult({
          ok: false,
          status: 'denied',
          error: { code: 'permission_denied', message: 'agents cannot', details: null, retryable: false },
        }),
        toolResult({
          status: 'pending_approval',
          output: { pending: true },
          approval: { approvalId: 'ap1', draftId: 'd1', previewHash: 'h', staleAt: 1 },
        }),
      ];
      server.handlers.set('tools.invoke', () => results.shift());
      const call = () => failure(Runtime.invoke(client, 'journal.delete_tag', { id: 't1' }));
      const failed = await call();
      expect(failed).toBeInstanceOf(ToolFailed);
      expect(failed).toMatchObject({ _tag: 'ToolFailed', code: 'not_found', message: 'no tag t1', callId: 'call-1' });
      const denied = await call();
      expect(denied).toBeInstanceOf(ToolDenied);
      expect(denied).toMatchObject({ _tag: 'ToolDenied', code: 'permission_denied' });
      const draft = await call();
      expect(draft).toBeInstanceOf(ToolAwaitingApproval);
      expect(draft).toMatchObject({ _tag: 'ToolAwaitingApproval', approvalId: 'ap1', draftId: 'd1' });
    }));

  it('hands failures, denials and drafts to invokeResult as results', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.invoke', () =>
        toolResult({
          ok: false,
          status: 'denied',
          error: { code: 'permission_denied', message: 'agents cannot', details: null, retryable: false },
        }),
      );
      const result = await Runtime.invokeResult(client, 'journal.delete_tag', { id: 't1' });
      expect(result).toMatchObject({ status: 'denied', output: null, error: { code: 'permission_denied' } });
    }));

  it('fails with ContractError when the output is not what the contract says', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.invoke', () => toolResult({ output: { changed: 'two' } }));
      const error = await failure(Runtime.invoke(client, 'journal.delete_tag', { id: 't1' }));
      expect(error).toBeInstanceOf(ContractError);
      expect(error).toMatchObject({ _tag: 'ContractError', source: 'tool journal.delete_tag', ran: true });
    }));

  it('fails with ContractError, without ran, when the tool result itself is not what the contract says', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.invoke', () => ({ status: 'ok' }));
      const error = await failure(Runtime.invoke(client, 'journal.delete_tag', { id: 't1' }));
      expect(error).toMatchObject({ _tag: 'ContractError', source: 'tools.invoke' });
      expect((error as ContractError).ran).toBeUndefined();
    }));
});

describe('Runtime core methods', () => {
  it('resolveApproval sends its params as sent, and an unreadable answer is a ContractError that ran', () =>
    withClient(async (client, server) => {
      server.handlers.set('approvals.resolve', () => ({ approval: 'none' }));
      const params = { approvalId: 'ap1', decision: 'approve' as const, previewHash: 'h', note: undefined };
      const error = await failure(Runtime.resolveApproval(client, params));
      expect(server.requests('approvals.resolve')[0]?.params).toEqual({
        approvalId: 'ap1',
        decision: 'approve',
        previewHash: 'h',
      });
      expect(error).toMatchObject({ _tag: 'ContractError', source: 'approvals.resolve', ran: true });
    }));

  it('listTools fails with ContractError on a list the contract does not describe', () =>
    withClient(async (client, server) => {
      server.handlers.set('tools.list', () => [{ name: 'x' }]);
      const error = await failure(Runtime.listTools(client));
      expect(error).toMatchObject({ _tag: 'ContractError', source: 'tools.list' });
    }));
});

describe('Runtime.asSent', () => {
  it('leaves undefined keys out, sends an undefined in a list as null and a bigint as a number', () => {
    const sent = Runtime.asSent({ a: 1, b: undefined, c: { d: undefined, e: [undefined, 2n] }, f: null, g: 7n });
    expect(sent).toEqual({ a: 1, c: { e: [null, 2] }, f: null, g: 7 });
    expect('b' in (sent as object)).toBe(false);
  });

  it('leaves values that are not plain objects as they are', () => {
    const date = new Date(0);
    const map = new Map([['k', undefined]]);
    const sent = Runtime.asSent({ date, map }) as { date: unknown; map: unknown };
    expect(sent.date).toBe(date);
    expect(sent.map).toBe(map);
    expect(Runtime.asSent('x')).toBe('x');
    expect(Runtime.asSent(undefined)).toBeUndefined();
  });
});

describe('Runtime.topic', () => {
  it('delivers decoded events and unsubscribes when stopped', () =>
    withClient(async (client, server) => {
      const signals: string[] = [];
      const groups: unknown[] = [];
      const stop = Runtime.topic(client, 'copy.groups', {}, (e) => {
        signals.push(e._tag);
        if (e._tag === 'Event') groups.push(e.data.groups);
      });
      await waitFor(() => signals.includes('Active'));
      server.last.push('copy.groups', 0, { groups: [] }, 's1');
      await waitFor(() => groups.length === 1);
      stop();
      await waitFor(() => server.requests('unsubscribe').length === 1);
      expect(server.requests('unsubscribe')[0]?.params).toEqual({ subscriptionId: 's1' });
      expect(signals).toEqual(['Active', 'Event']);
    }));

  it('ends with ContractError on an event the contract does not describe, and unsubscribes', () =>
    withClient(async (client, server) => {
      const signals: Runtime.TopicSignal<unknown>[] = [];
      Runtime.topic(client, 'copy.groups', {}, (e) => {
        signals.push(e);
      });
      await waitFor(() => signals.some((e) => e._tag === 'Active'));
      server.last.push('copy.groups', 1, { groups: 'none' }, 's1');
      server.last.push('copy.groups', 2, { groups: [] }, 's1');
      await waitFor(() => server.requests('unsubscribe').length === 1);
      expect(signals.map((e) => e._tag)).toEqual(['Active', 'Ended']);
      const ended = signals.at(-1);
      expect(ended?._tag === 'Ended' && ended.error).toBeInstanceOf(ContractError);
      expect(ended).toMatchObject({ error: { _tag: 'ContractError', source: 'topic copy.groups' } });
    }));

  it('says a refused subscription, and asks for it again on the next connection', () =>
    withClient(async (client, server) => {
      let refuse = true;
      server.handlers.set('subscribe', (p) => {
        if (refuse) {
          refuse = false;
          throw new HandlerError(-32003, 'nothing serves copy groups yet');
        }
        return { subscriptionId: 's1', topic: (p as { topic: string }).topic };
      });
      const signals: string[] = [];
      Runtime.topic(client, 'copy.groups', {}, (e) => {
        signals.push(e._tag === 'Refused' ? `Refused ${String(e.error.code)} ${e.error.message}` : e._tag);
      });
      await waitFor(() => signals.length === 1);
      expect(signals).toEqual(['Refused -32003 nothing serves copy groups yet']);
      server.dropAll();
      await waitFor(() => signals.length === 2);
      expect(signals[1]).toBe('Active');
    }));

  it('ends with ClientClosed when the client is closed', () =>
    withClient(async (client, server) => {
      const signals: Runtime.TopicSignal<unknown>[] = [];
      Runtime.topic(client, 'copy.groups', {}, (e) => {
        signals.push(e);
      });
      await waitFor(() => server.requests('subscribe').length === 1);
      client.close();
      expect(signals.at(-1)).toMatchObject({ _tag: 'Ended', error: { _tag: 'ClientClosed' } });
    }));
});

describe('RuntimeClient', () => {
  it('fails a request in flight with ConnectionLost when the socket drops', () =>
    withClient(async (client, server) => {
      server.respond = false;
      const lost = failure(client.request('never', {}));
      await waitFor(() => server.requests('never').length === 1);
      server.dropAll();
      const error = await lost;
      expect(error).toBeInstanceOf(ConnectionLost);
      expect(error).toMatchObject({ _tag: 'ConnectionLost', method: 'never' });
    }));

  it('times a request out with RequestTimeout', () =>
    withClient(async (client, server) => {
      server.respond = false;
      const error = await failed(client.request('slow', {}, { timeoutMs: 30 }));
      expect(error).toBeInstanceOf(RequestTimeout);
      expect(error).toMatchObject({ _tag: 'RequestTimeout', method: 'slow', timeoutMs: 30 });
    }));

  it('fails what is still pending with ClientClosed when closed', () =>
    withClient(async (client, server) => {
      server.respond = false;
      const pending = failure(client.request('pending', {}));
      await waitFor(() => server.requests('pending').length === 1);
      client.close();
      const error = await pending;
      expect(error).toBeInstanceOf(ClientClosed);
      expect(error).toMatchObject({ _tag: 'ClientClosed', method: 'pending' });
      expect(client.state.getSnapshot().status).toBe('closed');
    }));

  it('fails a request queued before the connection opens with ClientClosed when closed, and never connects', () =>
    withClient(async (client, server) => {
      const queued = failure(client.request('early', {}));
      client.close();
      expect(await queued).toMatchObject({ _tag: 'ClientClosed', method: 'early' });
      await elapse(30);
      expect(server.connections).toHaveLength(0);
      expect(client.state.getSnapshot().status).toBe('closed');
    }));
});

describe('typed errors', () => {
  it('say what happened in their message', () => {
    expect(new RequestTimeout({ method: 'tools.invoke', timeoutMs: 20 }).message).toBe(
      'tools.invoke: no response within 20ms',
    );
    expect(new ConnectionLost({ method: 'm', reason: 'code 1006' }).message).toBe('m: connection lost (code 1006)');
    expect(new ClientClosed({ method: 'm' }).message).toBe('m: client closed');
    expect(
      new ToolAwaitingApproval({ tool: 'orders.place', approvalId: 'a', draftId: null, callId: 'c' }).message,
    ).toBe('orders.place: waiting for approval');
  });

  it('are Errors that carry their name as _tag', () => {
    const error = new ToolFailed({ tool: 't', code: 'conflict', message: 'm', details: null, callId: 'c' });
    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe('ToolFailed');
    expect(error.name).toBe('ToolFailed');
    expect(new ContractError({ source: 's', message: 'm' }).ran).toBeUndefined();
  });
});

describe('Runtime.topic with invalid: log', () => {
  it('skips an event the contract does not describe and goes on', () =>
    withClient(async (client, server) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const signals: string[] = [];
      const groups: unknown[] = [];
      const stop = Runtime.topic(
        client,
        'copy.groups',
        {},
        (e) => {
          signals.push(e._tag);
          if (e._tag === 'Event') groups.push(e.data.groups);
        },
        { invalid: 'log' },
      );
      await waitFor(() => signals.includes('Active'));
      server.last.push('copy.groups', 1, { groups: 'none' }, 's1');
      server.last.push('copy.groups', 2, { groups: [] }, 's1');
      await waitFor(() => groups.length === 1);
      expect(groups).toEqual([[]]);
      expect(signals).toEqual(['Active', 'Event']);
      expect(logged).toHaveBeenCalledTimes(1);
      stop();
    }));
});
