import { describe, expect, it } from 'vitest';
import { createEchoGuard } from '../src/app/echoGuard.ts';

describe('echo guard', () => {
  it('never applies a write of its own coming back, even after the user moved on', () => {
    const g = createEchoGuard();
    expect(g.admit('view', 'overview', 'overview')).toBe(true);
    g.write('view', 'trades')('trades');
    expect(g.admit('view', 'trades', 'days')).toBe(false);
    const done = g.write('view', 'days');
    expect(g.admit('view', 'days', 'days')).toBe(false);
    done('days');
    expect(g.admit('view', 'reports', 'days')).toBe(true);
    expect(g.agreed('view')).toBe('"reports"');
  });

  it('never lets an older write undo a newer one, whichever answer comes first', () => {
    const g = createEchoGuard();
    g.admit('k', 1, 1);
    const a = g.write('k', 2);
    const b = g.write('k', 3);
    expect(g.admit('k', 2, 3)).toBe(false);
    expect(b(3)).toBe(true);
    expect(a(2)).toBe(false);
    expect(g.agreed('k')).toBe('3');
    expect(g.admit('k', 3, 3)).toBe(false);
    const c = g.write('k', 4);
    const d = g.write('k', 5);
    expect(g.admit('k', 5, 5)).toBe(false);
    c(4);
    d(5);
    expect(g.admit('k', 4, 5)).toBe(true);
  });

  it('holds off any value while a write of the key is in flight, and while a change is not written yet', () => {
    const g = createEchoGuard();
    g.admit('k', 'a', 'a');
    const done = g.write('k', 'b');
    expect(g.admit('k', 'x', 'b')).toBe(false);
    expect(g.writing('k')).toBe(true);
    done('b');
    expect(g.writing('k')).toBe(false);
    expect(g.admit('k', 'y', 'c')).toBe(false);
    expect(g.admit('k', 'z', 'b')).toBe(true);
  });

  it('compares values whatever order their fields were made in', () => {
    const g = createEchoGuard();
    g.admit('v', { a: 1, b: 2 }, { a: 1, b: 2 });
    g.write('v', { b: 3, a: 1 })({ a: 1, b: 3 });
    expect(g.admit('v', { a: 1, b: 3 }, { b: 3, a: 1 })).toBe(false);
    expect(g.admit('v', { a: 9, b: 3 }, { b: 3, a: 1 })).toBe(true);
  });

  it('takes a value equal to an old write as news once its echo is no longer awaited', () => {
    let t = 0;
    const g = createEchoGuard(() => t);
    g.admit('k', 'a', 'a');
    g.write('k', 'b')('b');
    g.write('k', 'a')('a');
    t = 60_000;
    expect(g.admit('k', 'b', 'a')).toBe(true);
  });

  it('agrees on what the runtime kept after a refusal', () => {
    const g = createEchoGuard();
    g.admit('k', 'a', 'a');
    const done = g.write('k', 'bad');
    expect(done('a')).toBe(true);
    expect(g.agreed('k')).toBe('"a"');
    expect(g.admit('k', 'b', 'a')).toBe(true);
  });
});
