import { describe, expect, it } from 'vitest';
import { Turns } from '../src/workspace/tiles/turns.ts';

function frames() {
  const pending: (() => void)[] = [];
  return {
    frame: (cb: () => void) => {
      pending.push(cb);
      return () => {
        const i = pending.indexOf(cb);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    next() {
      const cb = pending.shift();
      cb?.();
    },
    get pending() {
      return pending.length;
    },
  };
}

describe('tile turns', () => {
  it('lets the tiles of a dock mount one a frame, charts first, each in the order it asked', () => {
    const f = frames();
    const turns = new Turns(f.frame);
    const went: string[] = [];
    turns.take(false, () => went.push('trade'));
    turns.take(true, () => went.push('chart-1'));
    turns.take(false, () => went.push('analyst'));
    turns.take(true, () => went.push('chart-2'));
    expect(went).toEqual([]);
    expect(f.pending).toBe(1);
    f.next();
    expect(went).toEqual(['chart-1']);
    f.next();
    f.next();
    expect(went).toEqual(['chart-1', 'chart-2', 'trade']);
    f.next();
    expect(went).toEqual(['chart-1', 'chart-2', 'trade', 'analyst']);
    expect(turns.waiting).toBe(0);
    expect(f.pending).toBe(0);
  });

  it('forgets a turn given up before it came (a tile closed while the dock loads)', () => {
    const f = frames();
    const turns = new Turns(f.frame);
    const went: string[] = [];
    const giveUp = turns.take(false, () => went.push('positions'));
    turns.take(false, () => went.push('accounts'));
    giveUp();
    f.next();
    expect(went).toEqual(['accounts']);
    expect(f.pending).toBe(0);
  });

  it('goes on with the next turn when one fails', () => {
    const f = frames();
    const turns = new Turns(f.frame);
    const went: string[] = [];
    turns.take(true, () => {
      throw new Error('boom');
    });
    turns.take(false, () => went.push('trade'));
    expect(() => f.next()).toThrow('boom');
    f.next();
    expect(went).toEqual(['trade']);
  });
});
