import { describe, expect, it } from 'vitest';
import { computeBackoffDelay, DEFAULT_BACKOFF } from '../src/backoff.ts';
import { normalizeEpochMs, timeframeMs } from '../src/time.ts';
import { createStore } from '../src/store.ts';

describe('computeBackoffDelay', () => {
  const opts = { initialDelayMs: 100, maxDelayMs: 1_000, factor: 2, jitter: 0.5 };

  it('grows exponentially without jitter at random() = 0', () => {
    expect([1, 2, 3, 4].map((n) => computeBackoffDelay(n, opts, () => 0))).toEqual([100, 200, 400, 800]);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffDelay(10, opts, () => 0)).toBe(1_000);
    expect(computeBackoffDelay(50, opts, () => 0)).toBe(1_000);
  });

  it('jitters downward within [base·(1−j), base]', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffDelay(3, opts);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
    }
    expect(computeBackoffDelay(3, opts, () => 1)).toBe(200);
  });

  it('treats attempt < 1 as the first attempt and has sane defaults', () => {
    expect(computeBackoffDelay(0, opts, () => 0)).toBe(100);
    expect(computeBackoffDelay(1, DEFAULT_BACKOFF, () => 0)).toBe(DEFAULT_BACKOFF.initialDelayMs);
  });
});

describe('time helpers', () => {
  const ms = Date.UTC(2026, 9, 2, 18, 40);
  it('normalizes ns / µs / ms / s epochs to ms', () => {
    expect(normalizeEpochMs(ms * 1e6)).toBe(ms);
    expect(normalizeEpochMs(ms * 1e3)).toBe(ms);
    expect(normalizeEpochMs(ms)).toBe(ms);
    expect(normalizeEpochMs(ms / 1e3)).toBe(ms);
  });

  it('whole-second nanosecond timestamps survive a JSON round trip exactly', () => {
    const ns = ms * 1e6;
    expect(JSON.parse(JSON.stringify(ns))).toBe(ns);
    expect(Number.isSafeInteger(ns)).toBe(false);
    expect(normalizeEpochMs(JSON.parse(JSON.stringify(ns)) as number)).toBe(ms);
  });

  it('parses timeframes', () => {
    expect(timeframeMs('1s')).toBe(1_000);
    expect(timeframeMs('5m')).toBe(300_000);
    expect(timeframeMs('4h')).toBe(14_400_000);
    expect(timeframeMs('1D')).toBe(86_400_000);
    expect(() => timeframeMs('5x')).toThrow(RangeError);
  });
});

describe('createStore', () => {
  it('notifies on change only and supports unsubscribe', () => {
    const s = createStore({ n: 0 });
    let calls = 0;
    const off = s.subscribe(() => calls++);
    const snap = s.getSnapshot();
    s.set(snap);
    expect(calls).toBe(0);
    s.update((p) => ({ n: p.n + 1 }));
    expect(s.getSnapshot().n).toBe(1);
    expect(calls).toBe(1);
    off();
    s.set({ n: 2 });
    expect(calls).toBe(1);
  });
});
