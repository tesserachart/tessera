import { describe, expect, it } from 'vitest';
import { resultColor, tradeGeometry, tradesInView, type TradeMap, type TradeOverlay } from '../src/index.ts';

const colors = { entry: 'mist', up: 'up', down: 'down', stopZone: 'sz', targetZone: 'tz', label: 'l' };

const trade: TradeOverlay = {
  long: true,
  open: 100,
  close: 200,
  entry: 50,
  exit: 60,
  stop: [
    { t: 100, price: 40 },
    { t: 150, price: 48 },
  ],
  target: [{ t: 100, price: 70 }],
  fills: [
    { t: 101, price: 50, side: 'buy', qty: 1 },
    { t: 105, price: 50, side: 'buy', qty: 2 },
    { t: 200, price: 60, side: 'sell', qty: 3 },
  ],
  mae: 45,
  mfe: 65,
  colors,
};

const map: TradeMap = {
  xOf: (ms) => ms,
  yOf: (p) => 100 - p,
  barAt: (ms) => ({ x: ms - (ms % 10), high: 55, low: 45 }),
  lastTime: 300,
};

describe('trade geometry', () => {
  const g = tradeGeometry(trade, null, map);

  it('spans only the trade, from its open to its close', () => {
    expect(g.span).toEqual({ x0: 100, x1: 200 });
    expect(g.entry).toEqual({ x0: 100, x1: 200, y: 50 });
  });

  it('tints entry to stop and entry to target, stepping where the stop moved', () => {
    expect(g.zones).toEqual([
      { x0: 100, x1: 150, y0: 50, y1: 60, fill: 'sz' },
      { x0: 150, x1: 200, y0: 50, y1: 52, fill: 'sz' },
      { x0: 100, x1: 200, y0: 30, y1: 50, fill: 'tz' },
    ]);
    expect(g.joins).toEqual([{ x: 150, y0: 60, y1: 52, color: 'down' }]);
  });

  it("joins the entry to the exit in the result's colour", () => {
    expect(g.connector).toEqual({ x0: 100, y0: 50, x1: 200, y1: 40, color: 'up' });
    expect(resultColor({ ...trade, exit: 45 })).toBe('down');
    expect(resultColor({ ...trade, long: false, exit: 45 })).toBe('up');
    expect(resultColor({ ...trade, exit: 50 })).toBe('mist');
  });

  it("sums a bar's fills on one side into one triangle, under the bar bought and over it sold", () => {
    expect(g.fills).toEqual([
      { x: 100, y: 60, side: 'buy', qty: 3, color: 'up' },
      { x: 200, y: 40, side: 'sell', qty: 3, color: 'down' },
    ]);
  });

  it('draws only what had happened by a replay time', () => {
    const at = tradeGeometry(trade, 120, map);
    expect(at.span).toEqual({ x0: 100, x1: 120 });
    expect(at.connector).toBeNull();
    expect(at.excursions).toEqual([]);
    expect(at.fills.map((f) => f.qty)).toEqual([3]);
    expect(at.zones.map((z) => z.x1)).toEqual([120, 120]);
    expect(tradeGeometry(trade, 50, map).span).toBeNull();
  });

  it('runs an open trade to the end of the last bar', () => {
    const open = tradeGeometry({ ...trade, close: null, exit: null }, null, map);
    expect(open.span).toEqual({ x0: 100, x1: 300 });
    expect(open.connector).toBeNull();
  });
});

describe('trades in view', () => {
  const at = (open: number, close: number | null): TradeOverlay => ({ ...trade, open, close });

  it('keeps every trade open at some time in the view, and only those', () => {
    const trades = [at(0, 50), at(40, 120), at(150, 180), at(260, 400), at(500, null), at(90, null)];
    expect(tradesInView(trades, 100, 300).map((t) => [t.open, t.close])).toEqual([
      [40, 120],
      [150, 180],
      [260, 400],
      [90, null],
    ]);
  });
});
