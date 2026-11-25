import { onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { LatestWrite } from '../src/app/mutations.ts';

interface Pending<O> {
  readonly input: string;
  readonly done: (value: O) => void;
  readonly fail: (error: unknown) => void;
}

function held<O>() {
  const calls: Pending<O>[] = [];
  const write = (input: string) =>
    new Promise<O>((done, fail) => {
      calls.push({ input, done, fail });
    });
  return { calls, write };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('a write whose latest reply wins', () => {
  it('hands an older reply that lands last back as superseded, and the newer one as done', async () => {
    const { calls, write } = held<string>();
    const latest = new LatestWrite(write);
    const first = latest.send('a');
    const second = latest.send('b');
    await tick();
    calls[1]!.done('B');
    calls[0]!.done('A');
    expect(await second).toEqual({ kind: 'done', value: 'B' });
    expect(await first).toEqual({ kind: 'superseded' });
  });

  it('hands a reply dropped while on the way back as superseded, and is idle at once', async () => {
    const { calls, write } = held<string>();
    const latest = new LatestWrite(write);
    const sent = latest.send('a');
    await tick();
    expect(latest.pending).toBe(true);
    latest.drop();
    expect(latest.pending).toBe(false);
    calls[0]!.done('A');
    expect(await sent).toEqual({ kind: 'superseded' });
    expect(latest.pending).toBe(false);
  });

  it('says a refused write failed', async () => {
    const { calls, write } = held<string>();
    const latest = new LatestWrite(write);
    const sent = latest.send('a');
    await tick();
    calls[0]!.fail(new Error('refused'));
    expect(await sent).toMatchObject({ kind: 'failed', error: new Error('refused') });
  });

  it('runs writes that share a scope one at a time, in the order sent', async () => {
    const { calls, write } = held<string>();
    const one = new LatestWrite(write, { scope: 'layout-1' });
    const two = new LatestWrite(write, { scope: 'layout-1' });
    const first = one.send('a');
    const second = two.send('b');
    await tick();
    expect(calls.map((c) => c.input)).toEqual(['a']);
    calls[0]!.done('A');
    expect(await first).toEqual({ kind: 'done', value: 'A' });
    await tick();
    expect(calls.map((c) => c.input)).toEqual(['a', 'b']);
    calls[1]!.done('B');
    expect(await second).toEqual({ kind: 'done', value: 'B' });
  });

  it('still sends while the webview reads offline, since the runtime is on this machine', async () => {
    onlineManager.setOnline(false);
    const { calls, write } = held<string>();
    const latest = new LatestWrite(write);
    const sent = latest.send('a');
    await tick();
    expect(calls).toHaveLength(1);
    calls[0]!.done('A');
    expect(await sent).toEqual({ kind: 'done', value: 'A' });
  });
});
