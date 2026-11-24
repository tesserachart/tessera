import { describe, expect, it } from 'vitest';
import { stepGeometry, type StepLine } from '../src/index.ts';

describe('step lines', () => {
  const line: StepLine = {
    id: 'stop',
    steps: [
      { t: 0, price: 98 },
      { t: 30, price: 99 },
      { t: 60, price: null },
      { t: 90, price: 97 },
    ],
    end: 120,
    color: '#f00',
  };
  const g = stepGeometry(
    line,
    (ms) => ms,
    (p) => 200 - p,
  );

  it('holds each price until the next step, and the last until the end', () => {
    expect(g.runs).toEqual([
      { x0: 0, x1: 30, y: 102 },
      { x0: 30, x1: 60, y: 101 },
      { x0: 90, x1: 120, y: 103 },
    ]);
  });

  it('joins consecutive prices, never across a gap', () => {
    expect(g.joins).toEqual([{ x: 30, y0: 102, y1: 101 }]);
  });

  it('dots each move, not a stop appearing after a gap', () => {
    expect(g.dots).toEqual([{ x: 30, y: 101 }]);
  });

  it('skips steps before the data', () => {
    const before = stepGeometry(
      line,
      (ms) => (ms < 30 ? Number.NaN : ms),
      (p) => p,
    );
    expect(before.runs[0]).toEqual({ x0: 30, x1: 60, y: 99 });
  });
});
