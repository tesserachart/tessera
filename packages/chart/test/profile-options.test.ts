import { describe, expect, it } from 'vitest';
import { developingLines, rowDeltaLength, shownSessions, TickGrid, type SessionProfileData } from '../src/index.ts';

const ES = new TickGrid(0.25);

function session(label: string, from: number): SessionProfileData {
  return {
    from,
    to: from + 1,
    label,
    rowTicks: 1,
    lowTick: 0,
    rows: 0,
    volume: new Float64Array(0),
    buy: new Float64Array(0),
    sell: new Float64Array(0),
  };
}

describe('volume profile options', () => {
  it('shows the newest sessions, keeping a split session’s ETH and RTH parts together', () => {
    const days = ['Mon 28', 'Tue 29', 'Wed 30', 'Thu 1', 'Fri 2'].map((d, k) => session(d, k * 10));
    expect(shownSessions(days, 3).map((s) => s.label)).toEqual(['Wed 30', 'Thu 1', 'Fri 2']);
    expect(shownSessions(days, 30)).toHaveLength(5);
    expect(shownSessions(days, 0).map((s) => s.label)).toEqual(['Fri 2']);
    const split = days.flatMap((d) => [
      { ...d, to: d.from + 0.5, label: `${d.label} ETH` },
      { ...d, from: d.from + 0.5, label: `${d.label} RTH` },
    ]);
    expect(shownSessions(split, 2).map((s) => s.label)).toEqual(['Thu 1 ETH', 'Thu 1 RTH', 'Fri 2 ETH', 'Fri 2 RTH']);
  });

  it('shows the newest periods when older ones share their names', () => {
    const DAY = 10;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const days = [0, 1].flatMap((week) =>
      names.map((n, k) => ({ ...session(n, (week * 7 + k) * DAY), to: (week * 7 + k + 1) * DAY })),
    );
    expect(shownSessions(days, 2).map((s) => [s.label, s.from])).toEqual([
      ['Thu', 11 * DAY],
      ['Fri', 12 * DAY],
    ]);
    expect(shownSessions(days, 7).map((s) => s.label)).toEqual(['Fri', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    const rthOnly = days.map((d) => ({ ...d, label: `${d.label} RTH` }));
    expect(shownSessions(rthOnly, 1).map((s) => s.from)).toEqual([12 * DAY]);
    const sameName = [session('Mon', 0), session('Mon', 1)];
    expect(
      shownSessions(sameName, 1).map((s) => s.from),
      'touching periods of one name are two',
    ).toEqual([1]);
  });

  it('draws delta against the busiest delta', () => {
    expect(rowDeltaLength(-25, { maxDelta: 50 })).toBe(0.5);
    expect(rowDeltaLength(50, { maxDelta: 50 })).toBe(1);
    expect(rowDeltaLength(0, { maxDelta: 50 })).toBe(0);
    expect(rowDeltaLength(5, { maxDelta: 0 })).toBe(0);
  });

  it('traces the developing POC and value area bar by bar', () => {
    const bar = (lowTick: number, bid: number[], ask: number[]) => ({
      lowTick,
      rowTicks: 1,
      rows: bid.length,
      bid,
      ask,
    });
    const lines = developingLines(
      [null, bar(80000, [10, 30, 10], [10, 30, 10]), bar(80002, [5, 40, 5], [5, 40, 5]), null],
      0.7,
      ES,
    );
    expect([...lines.poc].slice(0, 1)).toEqual([Number.NaN]);
    expect(lines.poc[1]).toBe(20000.25);
    expect([lines.val[1], lines.vah[1]]).toEqual([20000, 20000.5]);
    expect(lines.poc[2]).toBe(20000.75);
    expect([lines.val[2], lines.vah[2]]).toEqual([20000.25, 20000.75]);
    expect(lines.poc[3]).toBe(20000.75);
  });
});
