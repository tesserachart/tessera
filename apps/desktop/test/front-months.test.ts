import { createCanvas } from '@napi-rs/canvas';
import { createHeadlessChart } from '@tessera/chart';
import type { CandlesOutput, ContractSpec, GetCandlesInput } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChartFeed, type FeedMeta } from '../src/chart/feed.ts';
import { legendItems } from '../src/chart/legend.ts';
import { BarSources } from '../src/market/bars.ts';
import { frontMonthsNote } from '../src/market/frontMonths.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { ns } from './support/time.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2025-12-01T00:00:00-06:00');
const N = 200;
const t = (i: number) => T0 + i * DAY;
const CONTRACTS = [
  { instrument: 'ESH6.CME', upTo: 40 },
  { instrument: 'ESM6.CME', upTo: 100 },
  { instrument: 'ESU6.CME', upTo: 170 },
  { instrument: 'ESZ6.CME', upTo: N },
];
const contractOf = (i: number) => CONTRACTS.find((c) => i < c.upTo)!.instrument;
const ANSWER_MAX = 100;

function candles(calls: GetCandlesInput[]) {
  return (input: GetCandlesInput): CandlesOutput => {
    calls.push(input);
    const to = input.to === undefined ? Infinity : input.to / 1e6;
    let held = Array.from({ length: N }, (_, i) => i).filter((i) => t(i) <= to);
    if (input.cachedOnly) held = [];
    held = held.slice(Math.max(0, held.length - Math.min(input.limit ?? 500, ANSWER_MAX)));
    const runs: { instrument: string; from: number; to: number }[] = [];
    for (const i of held) {
      const run = runs.at(-1);
      if (run?.instrument === contractOf(i)) run.to = ns(t(i));
      else runs.push({ instrument: contractOf(i), from: ns(t(i)), to: ns(t(i)) });
    }
    const earlier = input.frontMonths === true && runs.some((r) => r.instrument !== 'ESZ6.CME');
    return {
      instrument: 'ESZ6.CME',
      tf: '1D',
      priceDecimals: 2,
      tz: 'America/Chicago',
      columns: ['t', 'o', 'h', 'l', 'c', 'v'],
      bars: held.map((i) => [ns(t(i)), 6500 + i, 6510 + i, 6490 + i, 6501 + i, 1000 + i]),
      lastBarOpen: true,
      provider: 'mock',
      ...(earlier ? { contracts: runs } : {}),
    };
  };
}

const spec = { tickSize: 0.25, sessions: 'cme_equity_index', tz: 'America/Chicago' } as ContractSpec;

describe('front-month daily history', () => {
  it('asks for front months on every daily read, tags earlier contracts in the legend and names them in the strip', async () => {
    const calls: GetCandlesInput[] = [];
    fakeRuntime({ answers: { 'market.get_candles': candles(calls) } });
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => t(N - 1),
      initialBars: 150,
    });
    const meta = vi.fn<(m: FeedMeta) => void>();
    const sources = new BarSources({ keepMs: 0 });
    const feed = new ChartFeed(chart, { onMeta: meta, sources });
    feed.load('ES', '1D', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalled());

    const legend = (m: FeedMeta, time: number | undefined) =>
      legendItems({ layers: [], levels: [], precision: 2, contracts: m.contracts, charted: m.instrument }, time).map(
        (x) => x.text,
      );
    let m = meta.mock.calls[0]![0];
    expect(frontMonthsNote(m.contracts, m.instrument)).toBe('Front months from ES U6, unadjusted');
    expect(legend(m, t(120))).toEqual(['ES U6']);
    expect(legend(m, t(N - ANSWER_MAX))).toEqual(['ES U6']);
    expect(legend(m, t(N - 1))).toEqual([]);

    const { source, release } = sources.acquire('ES', '1D');
    source.pageOlder();
    await vi.waitFor(() => expect(chart.getSeries()!.time[0]).toBe(t(0)));
    await vi.waitFor(() =>
      expect(frontMonthsNote(meta.mock.lastCall![0].contracts, 'ESZ6.CME')).toBe('Front months from ES H6, unadjusted'),
    );
    m = meta.mock.lastCall![0];
    expect(legend(m, t(0))).toEqual(['ES H6']);
    expect(legend(m, t(50))).toEqual(['ES M6']);
    expect(legend(m, t(120))).toEqual(['ES U6']);
    expect(legend(m, t(N - 1))).toEqual([]);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c.frontMonths).toBe(true);
    release();
    feed.dispose();
    chart.destroy();
  });

  it('says nothing when every bar is the charted contract', () => {
    expect(frontMonthsNote([], 'ESZ6.CME')).toBeNull();
    expect(frontMonthsNote([{ instrument: 'ESZ6.CME', from: t(0), to: t(10) }], 'ESZ6.CME')).toBeNull();
  });
});
