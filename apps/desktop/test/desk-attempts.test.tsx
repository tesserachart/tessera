import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { attempt, DID_NOT_GO_THROUGH, useAttempt } from '../src/app/tools.ts';
import { setTestServices, TestRuntime, type FakeClient } from './support/runtime.tsx';

function answering(answer: (name: string, input: unknown) => Promise<unknown>): FakeClient {
  return {
    request: (method: string, params: { name: string; input: unknown }) =>
      method === 'tools.invoke' ? answer(params.name, params.input) : new Promise(() => undefined),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a desk attempt at a tool', () => {
  it('hands back what the tool returned', async () => {
    setTestServices(answering(() => Promise.resolve({ ok: true, output: { key: 'k', value: 1, previous: null } })));
    expect(await attempt('settings.set', { key: 'k', value: 1 })).toEqual({
      ok: true,
      out: { key: 'k', value: 1, previous: null },
    });
  });

  it('says why the runtime refused it, in its words', async () => {
    setTestServices(answering(() => Promise.resolve({ ok: false, error: { message: 'Pick a price above zero' } })));
    expect(await attempt('alerts.delete', { id: 'a1' })).toEqual({
      ok: false,
      drafted: false,
      why: 'Pick a price above zero',
    });
  });

  it('says it was drafted when the runtime holds it for approval', async () => {
    setTestServices(
      answering(() =>
        Promise.resolve({
          ok: false,
          status: 'pending_approval',
          approval: { approvalId: 'ap1', draftId: null, previewHash: 'h', staleAt: 1 },
        }),
      ),
    );
    expect(await attempt('alerts.delete', { id: 'a1' })).toEqual({
      ok: false,
      drafted: true,
      why: DID_NOT_GO_THROUGH,
    });
  });

  it('turns a call that got no answer into words, the caller’s own when it has them', async () => {
    setTestServices(answering(() => Promise.reject(new Error('gone'))));
    const plain = await attempt('alerts.delete', { id: 'a1' });
    const own = await attempt('alerts.delete', { id: 'a1' }, { unanswered: () => 'Orders shows it.' });
    expect(plain).toMatchObject({ ok: false, drafted: false });
    expect(plain.ok ? null : plain.why).not.toBe('');
    expect(own).toEqual({ ok: false, drafted: false, why: 'Orders shows it.' });
  });
});

describe('an attempt a component makes', () => {
  it('is busy while it runs, and an older reply that lands last is dropped for the newer one', async () => {
    const replies: ((v: unknown) => void)[] = [];
    const client = answering(
      () =>
        new Promise((resolve) => {
          replies.push(resolve);
        }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => <TestRuntime client={client}>{children}</TestRuntime>;
    const { result } = renderHook(() => useAttempt('alerts.delete'), { wrapper });
    expect(result.current.busy).toBe(false);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = result.current.run({ id: 'a1' });
      second = result.current.run({ id: 'a2' });
      await tick();
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      replies[1]!({ ok: false, error: { message: 'Newer' } });
      replies[0]!({ ok: false, error: { message: 'Older' } });
      await tick();
    });
    expect(await second).toEqual({ ok: false, drafted: false, why: 'Newer' });
    expect(await first).toBeNull();
    expect(result.current.busy).toBe(false);
  });
});

const SRC = join(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

function filesSaying(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .sort();
}

describe('one way for the desk to try a tool', () => {
  it('reads a tool’s raw result only in the attempt itself and the guarded order send', () => {
    expect(filesSaying(/\brunToolResult\(/)).toEqual(['app/tools.ts', 'shell/tradeActions.ts']);
  });

  it('turns a refusal into words in the attempt itself and the guarded order send alone', () => {
    expect(filesSaying(/error\?\.message \?\? (?!null)/)).toEqual(['app/tools.ts', 'shell/tradeActions.ts']);
  });
});
