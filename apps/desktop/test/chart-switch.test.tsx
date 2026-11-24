import type * as LevelSettingsModule from '../src/chart/levelSettings.ts';
import type * as ChartModule from '@tessera/chart';
import type { ChartOptions, HeadlessChart } from '@tessera/chart';
import { createCanvas } from '@napi-rs/canvas';
import {
  timeframeMs,
  type CandlesOutput,
  type ContractSpec,
  type GetCandlesInput,
  type Timeframe,
} from '@tessera/protocol';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRuntime } from './support/fakeRuntime.ts';

const drawn: HeadlessChart[] = [];
vi.mock('@tessera/chart', async (original) => {
  const real = await original<typeof ChartModule>();
  return {
    ...real,
    createChart: (_host: unknown, options: ChartOptions) => {
      const chart = real.createHeadlessChart({
        ...options,
        width: 1200,
        height: 700,
        createCanvas: (w, h) => createCanvas(w, h),
      });
      drawn.push(chart);
      return chart;
    },
  };
});
vi.mock('../src/market/flow/hub.ts', () => ({ flowHub: () => null }));
vi.mock('../src/chart/useLevelSources.ts', async () => {
  const { defsOf, sourceDefs } = await vi.importActual<typeof LevelSettingsModule>('../src/chart/levelSettings.ts');
  const sources = sourceDefs([]);
  return { useLevelSources: () => ({ sources, defs: defsOf(sources) }) };
});
vi.mock('../src/workspace/controller.ts', () => ({ updateChart: () => Promise.resolve() }));

const { ChartView } = await import('../src/chart/ChartView.tsx');
const { ClockContext } = await import('../src/app/clock.ts');
const { barSources, WARM_TIMEFRAMES } = await import('../src/market/bars.ts');

const T0 = Date.parse('2026-10-02T09:30:00-04:00');
const clock = { now: () => T0 + 200 * 60_000 } as never;

function candles(instrument: string, base: number, tf: Timeframe = '1m'): CandlesOutput {
  return {
    instrument,
    tf,
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v'],
    bars: Array.from({ length: 200 }, (_, i) => [
      (T0 + i * timeframeMs(tf)) * 1e6,
      base,
      base + 2,
      base - 2,
      base + 1,
      100,
    ]),
    lastBarOpen: true,
    provider: 'mock-market',
  };
}

const contract = (instrument: string) =>
  ({
    instrument,
    tickSize: 0.25,
    priceDecimals: 2,
    sessions: 'cme_equity_index',
    tz: 'America/New_York',
  }) as ContractSpec;

function view(instrument: string, spec: ContractSpec | undefined, tf: Timeframe = '1m') {
  return (
    <ClockContext.Provider value={clock}>
      <ChartView
        layoutId="l1"
        tileId="c1"
        instrument={instrument}
        tf={tf}
        spec={spec}
        layers={[]}
        levels={[]}
        annotations={[]}
        reportViewport={false}
        precision={2}
      />
    </ClockContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  drawn.length = 0;
});

describe('a chart switched to another symbol', () => {
  it('draws none of the last symbol while the new contract is looked up, and reads the new one at once', async () => {
    const rt = fakeRuntime();
    const snapshot = (instrument: string) =>
      vi.waitFor(() => {
        const read = rt.pending('market.get_candles');
        expect(read.input as GetCandlesInput).toEqual({ instrument, tf: '1m', limit: 1500 });
        return read;
      });
    const closes = () => {
      expect(drawn).toHaveLength(1);
      const s = drawn[0]!.getSeries()!;
      return Array.from({ length: s.length }, (_, i) => s.close[i]!);
    };

    const { rerender } = render(view('NQZ6.CME', contract('NQZ6.CME')));
    (await snapshot('NQZ6.CME')).ok(candles('NQZ6.CME', 29_700));
    await vi.waitFor(() => expect(closes()).toHaveLength(200));

    rerender(view('ESZ6.CME', undefined));
    expect(closes()).toEqual([]);
    (await snapshot('ESZ6.CME')).ok(candles('ESZ6.CME', 7_760));
    await vi.waitFor(() => expect(closes()).toHaveLength(200));
    expect(new Set(closes())).toEqual(new Set([7_761]));

    const reads = rt.toolCalls('market.get_candles').length;
    rerender(view('ESZ6.CME', contract('ESZ6.CME')));
    expect(new Set(closes())).toEqual(new Set([7_761]));
    expect(rt.toolCalls('market.get_candles')).toHaveLength(reads);
  });
});

describe('a chart switched to another timeframe', () => {
  it('shows the new timeframe’s bars at once, never an empty series in between', async () => {
    const price: Partial<Record<Timeframe, number>> = { '1m': 100, '5m': 500 };
    fakeRuntime({
      answers: { 'market.get_candles': (input) => candles(input.instrument, price[input.tf] ?? 900, input.tf) },
    });
    const closes = () => {
      expect(drawn).toHaveLength(1);
      const s = drawn[0]!.getSeries()!;
      return Array.from({ length: s.length }, (_, i) => s.close[i]!);
    };
    const { rerender } = render(view('NQZ6.CME', contract('NQZ6.CME')));
    await vi.waitFor(() => expect(new Set(closes())).toEqual(new Set([101])));
    await vi.waitFor(() => {
      for (const tf of WARM_TIMEFRAMES) {
        const held = barSources().acquire('NQZ6.CME', tf);
        const settled = held.source.settled;
        held.release();
        expect(settled, tf).toBe(true);
      }
    });
    const set = vi.spyOn(drawn[0]!, 'setData');

    rerender(view('NQZ6.CME', contract('NQZ6.CME'), '5m'));
    expect(closes()).toHaveLength(200);
    expect(new Set(closes())).toEqual(new Set([501]));
    expect(set.mock.calls.every((c) => (c[1] as { length: number }).length > 0)).toBe(true);
  });
});
