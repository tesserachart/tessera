import { describe, expect, it, vi } from 'vitest';
import { WarmPool } from '../src/app/warm.ts';
import { manualTimers } from './support/timers.ts';

function pool(keepMs: number, maxIdle: number) {
  const timers = manualTimers();
  const made: string[] = [];
  const gone: string[] = [];
  const p = new WarmPool<{ key: string }>({
    make: (key) => {
      made.push(key);
      return { key };
    },
    dispose: (v) => gone.push(v.key),
    keepMs,
    maxIdle,
    timers,
  });
  return { p, timers, made, gone };
}

describe('WarmPool', () => {
  it('shares one value per key among its holders', () => {
    const { p, made } = pool(1000, 2);
    const a = p.acquire('NQ');
    const b = p.acquire('NQ');
    expect(a.value).toBe(b.value);
    expect(made).toEqual(['NQ']);
    expect(p.size).toBe(1);
  });

  it('keeps a value after its last holder for keepMs, then lets it go', () => {
    const { p, timers, made, gone } = pool(1000, 2);
    const a = p.acquire('NQ');
    a.release();
    a.release();
    expect(gone).toEqual([]);
    expect(p.idle).toBe(1);
    timers.run(999);
    const back = p.acquire('NQ');
    expect(back.value).toBe(a.value);
    expect(made).toEqual(['NQ']);
    expect(p.idle).toBe(0);
    expect(timers.pending()).toBe(0);
    back.release();
    timers.run(1000);
    expect(gone).toEqual(['NQ']);
    expect(p.size).toBe(0);
    p.acquire('NQ');
    expect(made).toEqual(['NQ', 'NQ']);
  });

  it('keeps at most maxIdle values with no holder, the one idle longest going first', () => {
    const { p, gone } = pool(60_000, 2);
    for (const k of ['NQ', 'ES', 'YM']) p.acquire(k).release();
    expect(gone).toEqual(['NQ']);
    expect(p.idle).toBe(2);
    const held = p.acquire('ES');
    p.acquire('CL').release();
    expect(gone).toEqual(['NQ']);
    held.release();
    expect(gone).toEqual(['NQ', 'YM']);
  });

  it('lets a value go at once when nothing is kept', () => {
    const { p, gone } = pool(0, 4);
    p.acquire('NQ').release();
    expect(gone).toEqual(['NQ']);
    const q = pool(1000, 0);
    q.p.acquire('NQ').release();
    expect(q.gone).toEqual(['NQ']);
  });

  it('clears every value, and a late release of one cleared changes nothing', () => {
    const { p, gone, timers } = pool(1000, 2);
    const a = p.acquire('NQ');
    p.acquire('ES').release();
    p.clear();
    expect(gone.sort()).toEqual(['ES', 'NQ']);
    expect(timers.pending()).toBe(0);
    a.release();
    expect(gone).toHaveLength(2);
    expect(p.size).toBe(0);
  });

  it('takes a maker per acquire, and says when a dispose fails', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new WarmPool<number>({
      dispose: () => {
        throw new Error('boom');
      },
      keepMs: 0,
      maxIdle: 0,
    });
    const { value, release } = p.acquire('x', () => 7);
    expect(value).toBe(7);
    release();
    expect(err).toHaveBeenCalled();
    expect(() => p.acquire('y')).toThrow(/nothing makes y/);
    err.mockRestore();
  });
});
