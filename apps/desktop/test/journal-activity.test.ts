import type { ActivitySummary, PathStep, TradeActivity } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  chartSteps,
  clockSec,
  recordedPriceNote,
  recordedPrices,
  type RecordedPriceSource,
} from '../src/areas/journal/model/activity.ts';

const NS = 1e6;
const S = 1000 * NS;
const T = Date.UTC(2026, 9, 2, 14, 0, 5) * NS;

const summary: ActivitySummary = {
  coverage: 'complete',
  orders: 3,
  initialStop: 20590,
  initialStopAt: T,
  initialTarget: 20640,
  initialRisk: 200,
  initialRiskTicks: 40,
  rInitial: 0.98,
  stopMoves: 2,
  tightened: 2,
  widened: 0,
  trailSteps: 1,
  firstMoveSecs: 60,
  breakevenAt: null,
  breakevenSecs: null,
  unprotectedSecs: 0,
  neverProtected: false,
  worstStop: 20590,
  worstStopTicks: 40,
  endedBy: 'stop',
};

const activity = (stopPath: PathStep[], targetPath: PathStep[] = []): TradeActivity => ({
  summary,
  stopPath,
  targetPath,
  moves: [],
  rows: [],
  end: T + 600 * S,
  liveSince: T,
});

const source = (
  over: Partial<RecordedPriceSource['trade']> = {},
  act: TradeActivity | null = null,
): RecordedPriceSource => ({
  activity: act,
  pointValue: 20,
  tickSize: 0.25,
  trade: { side: 'buy', entryPrice: 20600, qty: 1, stopPrice: 20590, targetPrice: 20640, ...over },
});

describe('the prices a leg stood at', () => {
  const stops: PathStep[] = [
    { t: T, price: 20590 },
    { t: T + 30 * S, price: 20590 },
    { t: T + 60 * S, price: 20595 },
    { t: T + 90 * S, price: null },
    { t: T + 120 * S, price: 20595 },
    { t: T + 150 * S, price: 20602.5 },
  ];

  it('lists the first, each move and the last, in time order, each price once at its first time', () => {
    const got = recordedPrices(source({}, activity(stops)), 'stop');
    expect(got.map((p) => [p.price, (p.t - T) / S])).toEqual([
      [20590, 0],
      [20595, 60],
      [20602.5, 150],
    ]);
  });

  it('says how far each is from the entry and the money there for a long', () => {
    const got = recordedPrices(source({}, activity(stops, [{ t: T, price: 20640 }])), 'stop');
    expect(got.map((p) => [p.ticks, p.money])).toEqual([
      [40, -200],
      [20, -100],
      [10, 50],
    ]);
    const [target] = recordedPrices(source({}, activity(stops, [{ t: T, price: 20640 }])), 'target');
    expect([target?.ticks, target?.money]).toEqual([160, 800]);
  });

  it('turns the money round for a short and counts the whole quantity', () => {
    const d = source(
      { side: 'sell', qty: 2, stopPrice: 20610, targetPrice: 20580 },
      activity(
        [
          { t: T, price: 20610 },
          { t: T + 60 * S, price: 20605 },
        ],
        [{ t: T, price: 20580 }],
      ),
    );
    expect(recordedPrices(d, 'stop').map((p) => [p.ticks, p.money])).toEqual([
      [40, -400],
      [20, -200],
    ]);
    expect(recordedPrices(d, 'target').map((p) => [p.ticks, p.money])).toEqual([[80, 800]]);
  });

  it('marks the plan’s own price, typed or filled in, within half a tick', () => {
    const a = activity(stops);
    expect(recordedPrices(source({}, a), 'stop').map((p) => p.current)).toEqual([true, false, false]);
    expect(recordedPrices(source({ stopPrice: 20595.0001 }, a), 'stop').map((p) => p.current)).toEqual([
      false,
      true,
      false,
    ]);
    expect(recordedPrices(source({ stopPrice: 20597 }, a), 'stop').some((p) => p.current)).toBe(false);
    expect(recordedPrices(source({ stopPrice: null }, a), 'stop').some((p) => p.current)).toBe(false);
  });

  it('offers nothing without recorded prices for the leg', () => {
    expect(recordedPrices(source(), 'stop')).toEqual([]);
    expect(recordedPrices(source({}, activity([], [])), 'target')).toEqual([]);
    expect(recordedPrices(source({}, activity([{ t: T, price: null }])), 'stop')).toEqual([]);
    expect(recordedPrices(source({}, activity(stops)), 'target')).toEqual([]);
  });

  it('reads each as ticks and money', () => {
    const [first, , last] = recordedPrices(source({}, activity(stops)), 'stop');
    expect(recordedPriceNote(first!)).toBe('40 ticks · −$200.00');
    expect(recordedPriceNote(last!)).toBe('10 ticks · +$50.00');
    const [bare] = recordedPrices({ ...source({}, activity(stops)), tickSize: 0 }, 'stop');
    expect(bare?.ticks).toBeNull();
    expect(recordedPriceNote(bare!)).toBe('−$200.00');
  });
});

describe('the chart’s paths', () => {
  it('turn into steps in milliseconds', () => {
    expect(
      chartSteps([
        { t: T, price: 20590 },
        { t: T + 30_000 * NS, price: null },
      ]),
    ).toEqual([
      { t: T / NS, price: 20590 },
      { t: T / NS + 30_000, price: null },
    ]);
  });

  it('time each price to the second', () => {
    expect(clockSec(T)).toBe('10:00:05');
  });
});
