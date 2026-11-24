import { createCanvas } from '@napi-rs/canvas';
import { CHART_MAX_BARS, createHeadlessChart } from '@tessera/chart';
import type { CandlesOutput, ContractSpec, GetCandlesInput } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChartFeed } from '../src/chart/feed.ts';
import { BarSources } from '../src/market/bars.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { threadMs } from './support/cpu.ts';

const REPORT = process.env.TESSERA_PERF_REPORT === '1';
const LIMIT_MS = REPORT ? 33 : 250;
const T0 = Date.parse('2026-09-01T09:30:00-04:00');
const spec = { tickSize: 0.25, sessions: 'cme_equity_index', tz: 'America/New_York' } as ContractSpec;

function candles(n: number, input: GetCandlesInput): CandlesOutput {
  const to = input.to === undefined ? Infinity : input.to / 1e6;
  const bars: CandlesOutput['bars'] = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 60_000;
    if (t > to) break;
    const p = 20_000 + Math.sin(i / 50) * 40;
    bars.push([t * 1e6, p, p + 2, p - 2, p + 0.5, 100 + (i % 50), 50]);
  }
  return {
    instrument: 'NQZ6.CME',
    tf: '1m',
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v', 'bv'],
    bars: bars.slice(Math.max(0, bars.length - (input.limit ?? 500))),
    lastBarOpen: true,
    provider: 'mock-market',
  };
}

describe('perf: a chart switched back to', () => {
  it('draws the bars its market holds from memory: no read, no subscription', async () => {
    const rt = fakeRuntime();
    const reads: GetCandlesInput[] = [];
    const all = CHART_MAX_BARS;
    const sources = new BarSources({
      keepMs: 60_000,
      reader: {
        candles: (input) => {
          reads.push(input);
          return Promise.resolve(candles(all, input));
        },
      },
    });
    const chart = () =>
      createHeadlessChart({
        width: 1200,
        height: 700,
        createCanvas: (w, h) => createCanvas(w, h),
        now: () => T0 + all * 60_000,
        initialBars: 150,
      });
    const first = chart();
    const meta = vi.fn();
    const feed = new ChartFeed(first, { onMeta: meta, sources });
    feed.load('NQ', '1m', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalled());
    const history = await vi.waitFor(() => rt.sub('market.history'));
    history.event({ instrument: 'NQ', from: T0 * 1e6, to: null, filling: false });
    await vi.waitFor(() => expect(first.getSeries()!.length).toBe(all));
    feed.dispose();
    first.destroy();
    const readsBefore = reads.length;
    const subsBefore = rt.subscriptions.length;

    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const back = chart();
      const shown = vi.fn();
      const again = new ChartFeed(back, { onMeta: shown, sources });
      const t = threadMs();
      again.load('NQ', '1m', spec);
      back.render(true);
      samples.push(threadMs() - t);
      expect(back.getSeries()!.length).toBe(all);
      expect(shown).toHaveBeenCalledWith(expect.objectContaining({ instrument: 'NQZ6.CME', bars: expect.any(Number) }));
      again.dispose();
      back.destroy();
    }
    expect(reads).toHaveLength(readsBefore);
    expect(rt.subscriptions).toHaveLength(subsBefore);
    const median = samples.slice(2).sort((a, b) => a - b)[2]!;
    if (REPORT) console.info(`[perf] ${String(all)} held bars on a new chart, drawn: median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(LIMIT_MS);
    sources.clear();
  });
});
