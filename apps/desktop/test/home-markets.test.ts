import type { Position, Quote } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { chartsBrief, retargetDock } from '../src/frame/workspaces.ts';
import { nextSort, positionLine, rangeAt, sortRows, sortValue } from '../src/markets/lists.ts';

const money = (amount: number) => ({ amount, currency: 'USD' as const });

const quote = (last: number | null, prev: number | null, volume = 0, lo?: number, hi?: number): Quote => ({
  instrument: 'X',
  ts: 0,
  bid: null,
  bidSize: null,
  ask: null,
  askSize: null,
  last,
  lastSize: null,
  session: { tradeDate: '2026-10-02', open: null, high: hi ?? null, low: lo ?? null, prevClose: prev, volume },
  source: null,
});

describe('Markets lists', () => {
  it('sorts by a column: numbers down first, symbols up first, a third click back to the list’s order', () => {
    expect(nextSort(null, 'pct')).toEqual({ key: 'pct', dir: 'desc' });
    expect(nextSort({ key: 'pct', dir: 'desc' }, 'pct')).toEqual({ key: 'pct', dir: 'asc' });
    expect(nextSort({ key: 'pct', dir: 'asc' }, 'pct')).toBeNull();
    expect(nextSort({ key: 'pct', dir: 'asc' }, 'symbol')).toEqual({ key: 'symbol', dir: 'asc' });
  });

  it('puts rows with no value last either way and keeps ties in the list’s order', () => {
    const q: Record<string, Quote> = { A: quote(10, 9), B: quote(null, 9), C: quote(5, 4), D: quote(20, 19) };
    const rows = ['A', 'B', 'C', 'D'];
    const by = (r: string, k: 'last' | 'chg' | 'pct' | 'vol' | 'symbol') => sortValue(k, r, q[r]);
    expect(sortRows(rows, { key: 'last', dir: 'desc' }, by)).toEqual(['D', 'A', 'C', 'B']);
    expect(sortRows(rows, { key: 'last', dir: 'asc' }, by)).toEqual(['C', 'A', 'D', 'B']);
    expect(sortRows(rows, { key: 'chg', dir: 'desc' }, by)).toEqual(['A', 'C', 'D', 'B']);
    expect(sortRows(rows, null, by)).toEqual(rows);
    expect(sortValue('vol', 'A', quote(1, 1, 0))).toBeNull();
    expect(sortValue('vol', 'A', quote(1, 1, 1200))).toBe(1200);
  });

  it('says a held position as one line in the colour of its open P&L', () => {
    const p = (qty: number, pnl: number | null): Position => ({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      qty,
      avgPrice: 1,
      realizedPnl: money(0),
      unrealizedPnl: pnl === null ? null : money(pnl),
      mark: null,
      openedAt: 0,
    });
    expect(positionLine(p(5, -295))).toEqual({ text: 'Long 5 · −$295.00', tone: 'down' });
    expect(positionLine(p(-2, 310))).toEqual({ text: 'Short 2 · +$310.00', tone: 'up' });
    expect(positionLine(p(1, null))).toEqual({ text: 'Long 1', tone: null });
  });

  it('places the last price in the day’s range, or nothing without one', () => {
    expect(rangeAt(quote(15, 10, 0, 10, 20))).toBe(0.5);
    expect(rangeAt(quote(25, 10, 0, 10, 20))).toBe(1);
    expect(rangeAt(quote(15, 10))).toBeNull();
  });
});

describe('Home → Workspaces', () => {
  it('says what a workspace’s charts show', () => {
    expect(
      chartsBrief([
        { instrument: 'QQQ', timeframe: '5m' },
        { instrument: 'NQZ6.CME', timeframe: '1m' },
      ]),
    ).toBe('QQQ 5m · NQ Z6 1m');
  });

  it('copies a dock tree to another layout: its chart panels name the new one', () => {
    const dock = {
      grid: { root: {} },
      panels: {
        'chart-1': { id: 'chart-1', contentComponent: 'chart', params: { layoutId: 'default', tileId: 'chart-1' } },
        w: { id: 'w', contentComponent: 'watchlist' },
      },
    };
    const out = retargetDock(dock, 'default', 'ws-2') as typeof dock;
    expect(out.panels['chart-1'].params).toEqual({ layoutId: 'ws-2', tileId: 'chart-1' });
    expect(out.panels.w).toEqual(dock.panels.w);
    expect(retargetDock(null, 'a', 'b')).toBeNull();
  });
});
