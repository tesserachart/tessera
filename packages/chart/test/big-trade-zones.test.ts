import { describe, expect, it } from 'vitest';
import { bigTradeZones, plotPrice, type BigTrade, type BigTradeZoneOptions } from '../src/index.ts';

const MIN = 60_000;
const OHLC = [
  [100, 103, 99, 102],
  [102, 102.5, 99.5, 100],
  [100, 104, 99.75, 101],
  [101, 101.5, 100.5, 101],
  [101, 101.25, 100.25, 100.5],
  [100.5, 101, 100, 100.75],
] as const;

const bars = {
  length: OHLC.length,
  time: OHLC.map((_, i) => i * MIN),
  open: OHLC.map((b) => b[0]),
  high: OHLC.map((b) => b[1]),
  low: OHLC.map((b) => b[2]),
  close: OHLC.map((b) => b[3]),
  indexAtOrBefore: (t: number) => Math.min(OHLC.length - 1, Math.floor(t / MIN)),
};

const trade = (t: number, side: 1 | -1, price: number, size: number, first = price, last = price): BigTrade => ({
  t,
  side,
  price,
  size,
  prints: 1,
  ref: String(t),
  firstPrice: first,
  lastPrice: last,
});

const A = trade(10, 1, 102.75, 40, 102.5, 103);
const B = trade(20, 1, 101, 20);
const C = trade(MIN + 5, 1, 100.75, 30);
const D = trade(2 * MIN + 5, -1, 103.5, 25);
const E = trade(3 * MIN + 5, -1, 101.25, 15);
const ALL = [A, B, C, D, E];

const DEFAULTS: BigTradeZoneOptions = { bars: 10, biggest: false, body: 'trend', wick: 'all' };

const spans = (o: Partial<BigTradeZoneOptions> = {}, at: 'vwap' | 'start' | 'last' = 'vwap') =>
  bigTradeZones(ALL, bars, { ...DEFAULTS, ...o }, 0.25, at).map((z) => [z.from, z.to, z.low, z.high, z.side]);

describe('big-trade zones', () => {
  it('project a band a tick either side from the bar after the trade, ending where a bar trades through it', () => {
    expect(spans()).toEqual([
      [0, 1, 100.75, 101.25, 1],
      [0, 2, 102.5, 103, 1],
      [2, 5, 103.25, 103.75, -1],
      [3, 4, 101, 101.5, -1],
    ]);
  });

  it('pick trades by body or wick and by trend or reversal, and can keep the biggest of each bar', () => {
    expect(spans({ biggest: true }).map((z) => z.slice(0, 2))).toEqual([
      [0, 2],
      [2, 5],
      [3, 4],
    ]);
    expect(spans({ body: 'all' })).toContainEqual([1, 2, 100.5, 101, 1]);
    expect(spans({ wick: 'none' })).toEqual([[0, 1, 100.75, 101.25, 1]]);
    expect(spans({ body: 'reversal', wick: 'none' })).toEqual([[1, 2, 100.5, 101, 1]]);
    expect(spans({ body: 'none', wick: 'trend' }).map((z) => z.slice(0, 2))).toEqual([
      [0, 2],
      [3, 4],
    ]);
  });

  it('stop at the bars forward they are given', () => {
    expect(spans({ bars: 2 })).toContainEqual([2, 4, 103.25, 103.75, -1]);
  });

  it('follow the plot price the bubbles use', () => {
    expect(plotPrice(A, 'vwap')).toBe(102.75);
    expect(plotPrice(A, 'start')).toBe(102.5);
    expect(plotPrice(A, 'last')).toBe(103);
    expect(plotPrice({ ...A, firstPrice: undefined }, 'start')).toBe(102.75);
    expect(spans({}, 'start')).toContainEqual([0, 1, 102.25, 102.75, 1]);
  });
});
