import type { BacktestTrade } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { tradeRange } from '../src/chart/linkedTrade.ts';
import { linkedTradeGeometry } from '../src/chart/linkedTradeLayer.ts';

const BAR_MS = 300_000;
const BAR_PX = 20;
const T0 = Date.parse('2026-09-22T14:10:00Z');
const map = {
  xOfTime: (ms: number) => ((ms - T0) / BAR_MS) * BAR_PX,
  yOf: (price: number) => 1000 - price / 10,
  barSpacing: BAR_PX,
};
const trade = (over: Partial<BacktestTrade>): BacktestTrade => ({
  qty: 1,
  entryTime: T0 * 1e6,
  entryPrice: 20_207.75,
  exitTime: T0 * 1e6,
  exitPrice: 20_192.5,
  pnl: -307,
  costs: 12,
  bars: 0,
  mae: -355,
  mfe: 430,
  exit: 'stop',
  stop: 20_192.75,
  target: 20_237.75,
  approximate: true,
  ...over,
});

describe('a trade linked from Research reads on the chart', () => {
  it('spans its whole bar when it opens and closes inside one', () => {
    const g = linkedTradeGeometry(trade({}), map)!;
    expect(g.left).toBe(0);
    expect(g.right).toBe(BAR_PX);
  });

  it('puts the buy and the sell at their own prices, not at the bar’s high or low', () => {
    const g = linkedTradeGeometry(trade({}), map)!;
    expect(g.entry).toEqual({ x: 0, y: map.yOf(20_207.75), side: 'buy' });
    expect(g.exit).toEqual({ x: BAR_PX, y: map.yOf(20_192.5), side: 'sell' });
    expect(g.stop).toBe(map.yOf(20_192.75));
    expect(g.target).toBe(map.yOf(20_237.75));
  });

  it('ends a signal exit at the open of its bar and a stop or target at the bar’s close', () => {
    const later = (T0 + 3 * BAR_MS) * 1e6;
    expect(linkedTradeGeometry(trade({ exit: 'signal', exitTime: later }), map)!.right).toBe(3 * BAR_PX);
    expect(linkedTradeGeometry(trade({ exit: 'target', exitTime: later }), map)!.right).toBe(4 * BAR_PX);
    const short = linkedTradeGeometry(trade({ qty: -1 }), map)!;
    expect([short.entry.side, short.exit.side]).toEqual(['sell', 'buy']);
  });

  it('frames a short trade with a dozen bars each side, a long one with its own length', () => {
    const step = BAR_MS * 1e6;
    const t = trade({});
    expect(tradeRange(t, step)).toEqual({ from: t.entryTime - 12 * step, to: t.exitTime + 13 * step });
    const long = trade({ exitTime: t.entryTime + 40 * step });
    expect(tradeRange(long, step)).toEqual({ from: t.entryTime - 40 * step, to: long.exitTime + 41 * step });
  });
});
