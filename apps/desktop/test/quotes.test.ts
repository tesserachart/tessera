import type { Quote } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { QuoteStore, quoteChange } from '../src/market/quotes.ts';
import { fakeRuntime, type FakeRuntime } from './support/fakeRuntime.ts';
import { pause } from './support/pause.ts';

const q = (instrument: string, last: number): Quote => ({
  instrument,
  ts: 0,
  bid: last - 0.01,
  bidSize: 1,
  ask: last + 0.01,
  askSize: 1,
  last,
  lastSize: 1,
  session: { tradeDate: '2026-10-02', open: null, high: null, low: null, prevClose: 487.1, volume: 0 },
  source: { provider: 'rithmic-test' },
});

const quotes = (rt: FakeRuntime) => vi.waitFor(() => rt.sub('market.quotes'));

describe('QuoteStore', () => {
  it('keeps one subscription for the union of watched instruments', async () => {
    const rt = fakeRuntime();
    const store = new QuoteStore();
    const r1 = store.watch('QQQ');
    const r2 = store.watch('SPY');
    store.flush();
    const first = await quotes(rt);
    expect(first.params).toEqual({ instruments: ['QQQ', 'SPY'] });
    store.watch('QQQ');
    store.flush();
    await pause();
    expect(rt.subscriptions).toHaveLength(1);
    r2();
    store.flush();
    await vi.waitFor(() => expect(first.open).toBe(false));
    const second = await quotes(rt);
    expect(second.params).toEqual({ instruments: ['QQQ'] });
    r1();
    r1();
    store.flush();
    expect(store.subscribed).toEqual(['QQQ']);
    await pause();
    expect(second.open).toBe(true);
    expect(rt.subscriptions).toHaveLength(2);
    store.dispose();
  });

  it('subscribes the new set before the old one ends', async () => {
    const rt = fakeRuntime();
    const store = new QuoteStore();
    store.watch('QQQ');
    store.flush();
    const first = await quotes(rt);
    store.watch('SPY');
    store.flush();
    expect(rt.subscriptions).toHaveLength(2);
    expect(rt.subscriptions[1]!.params).toEqual({ instruments: ['QQQ', 'SPY'] });
    await vi.waitFor(() => expect(first.open).toBe(false));
    store.dispose();
  });

  it('keeps an instrument subscribed a while after its last watcher, so a view that comes back changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const rt = fakeRuntime();
      const store = new QuoteStore({ keepMs: 60_000 });
      const nq = store.watch('NQ');
      store.watch('ES');
      store.flush();
      const sub = await quotes(rt);
      nq();
      store.flush();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.subscribed).toEqual(['ES', 'NQ']);
      const again = store.watch('NQ');
      store.flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rt.subscriptions).toHaveLength(1);
      expect(sub.open).toBe(true);
      again();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.subscribed).toEqual(['ES']);
      expect(rt.subscriptions).toHaveLength(2);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('batches interest changes to one resubscribe per microtask', async () => {
    const rt = fakeRuntime();
    const store = new QuoteStore();
    store.watch('A');
    store.watch('B');
    store.watch('C');
    await Promise.resolve();
    expect(store.subscribed).toEqual(['A', 'B', 'C']);
    expect((await quotes(rt)).params).toEqual({ instruments: ['A', 'B', 'C'] });
    await pause();
    expect(rt.subscriptions).toHaveLength(1);
    store.dispose();
  });

  function manualFrames() {
    const pending: (() => void)[] = [];
    return {
      pending,
      frame: (cb: () => void) => {
        pending.push(cb);
        return () => {
          const i = pending.indexOf(cb);
          if (i >= 0) pending.splice(i, 1);
        };
      },
      run() {
        for (const cb of pending.splice(0)) cb();
      },
    };
  }

  it('notifies only the ticked instrument, on the next frame', async () => {
    const rt = fakeRuntime();
    const frames = manualFrames();
    const store = new QuoteStore({ frame: frames.frame });
    store.watch('QQQ');
    store.watch('SPY');
    store.flush();
    const sub = await quotes(rt);
    const qqq = vi.fn();
    const spy = vi.fn();
    store.listen('QQQ', qqq);
    store.listen('SPY', spy);
    sub.event(q('QQQ', 487.85));
    await vi.waitFor(() => expect(store.get('QQQ')?.last).toBe(487.85));
    expect(qqq).not.toHaveBeenCalled();
    frames.run();
    expect(qqq).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
    store.dispose();
  });

  it('coalesces a burst of quotes into one notification per instrument per frame', async () => {
    const rt = fakeRuntime();
    const frames = manualFrames();
    const store = new QuoteStore({ frame: frames.frame });
    store.watch('QQQ');
    store.watch('SPY');
    store.flush();
    const sub = await quotes(rt);
    const qqq = vi.fn();
    const spy = vi.fn();
    store.listen('QQQ', qqq);
    store.listen('SPY', spy);
    for (let i = 0; i < 50; i++) sub.event(q('QQQ', 487 + i / 100));
    for (let i = 0; i < 20; i++) sub.event(q('SPY', 551 + i / 100));
    await vi.waitFor(() => expect(store.get('SPY')?.last).toBeCloseTo(551.19, 9));
    expect(frames.pending).toHaveLength(1);
    frames.run();
    expect(qqq).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();
    expect(store.get('QQQ')?.last).toBeCloseTo(487.49, 9);
    expect(store.get('SPY')?.last).toBeCloseTo(551.19, 9);
    sub.event(q('SPY', 552));
    await vi.waitFor(() => expect(store.get('SPY')?.last).toBe(552));
    frames.run();
    expect(qqq).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('schedules no frame for instruments nobody listens to, and cancels on dispose', async () => {
    const rt = fakeRuntime();
    const frames = manualFrames();
    const store = new QuoteStore({ frame: frames.frame });
    store.watch('QQQ');
    store.flush();
    const sub = await quotes(rt);
    sub.event(q('QQQ', 487.85));
    await vi.waitFor(() => expect(store.get('QQQ')?.last).toBe(487.85));
    expect(frames.pending).toHaveLength(0);
    store.listen('QQQ', vi.fn());
    sub.event(q('QQQ', 487.86));
    await vi.waitFor(() => expect(store.get('QQQ')?.last).toBe(487.86));
    expect(frames.pending).toHaveLength(1);
    store.dispose();
    expect(frames.pending).toHaveLength(0);
    await vi.waitFor(() => expect(sub.open).toBe(false));
  });

  it('tells every instrument’s ticks to an all-listener, once per frame', async () => {
    const rt = fakeRuntime();
    const frames: (() => void)[] = [];
    const store = new QuoteStore({
      frame: (cb) => {
        frames.push(cb);
        return () => undefined;
      },
    });
    store.watch('QQQ');
    store.watch('FAKE');
    store.flush();
    const sub = await quotes(rt);
    const all = vi.fn();
    store.listenAll(all);
    sub.event(q('QQQ', 487.85));
    sub.event(q('FAKE', 100));
    await vi.waitFor(() => expect(store.get('FAKE')?.last).toBe(100));
    expect(store.get('QQQ')?.last).toBe(487.85);
    for (const f of frames.splice(0)) f();
    expect(all).toHaveBeenCalledOnce();
    store.dispose();
  });

  it('computes change and change %', () => {
    const { change, pct } = quoteChange(q('QQQ', 487.85));
    expect(change).toBeCloseTo(0.75, 9);
    expect(pct).toBeCloseTo(0.154, 3);
    expect(quoteChange(undefined)).toEqual({ change: null, pct: null });
  });
});
