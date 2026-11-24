import type { BarTuple } from '@tessera/chart';
import type { GetPrintBarsInput, PrintBarsOutput } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { BarsSink, HistoryEnd } from '../src/market/bars.ts';
import { PRINT_BAR_CHOICES, printBarsKey, printBarsShort, printBarsWords } from '../src/market/instruments.ts';
import { MAX_PRINT_BAR_SESSIONS } from '../src/market/intervals.ts';
import { changeOf, PrintBarSource } from '../src/market/printBars.ts';

const bar = (t: number, c: number, v: number): BarTuple => [t, 100, 101, 99, c, v, v / 2];

describe('tick, range, volume, delta and renko bars on the chart', () => {
  it('names each kind short in the tab row and in words in the menu', () => {
    expect(PRINT_BAR_CHOICES.map(printBarsShort)).toEqual([
      '100T',
      '500T',
      '1000T',
      '4R',
      '10R',
      '20R',
      '1000V',
      '5000V',
      '100Δ',
      '300Δ',
      '500Δ',
      '4Rk',
      '10Rk',
      '20Rk',
    ]);
    expect(printBarsWords({ kind: 'tick', size: 1000 })).toBe('1,000 ticks');
    expect(printBarsWords({ kind: 'range', size: 10 })).toBe('10 ticks range');
    expect(printBarsWords({ kind: 'volume', size: 5000 })).toBe('5,000 contracts');
    expect(printBarsWords({ kind: 'delta', size: 300 })).toBe('300 delta');
    expect(printBarsWords({ kind: 'renko', size: 10 })).toBe('10 ticks renko');
    expect(new Set(PRINT_BAR_CHOICES.map(printBarsKey)).size).toBe(PRINT_BAR_CHOICES.length);
  });

  it('updates only the forming bar and the bars after it, and starts over when older bars change', () => {
    const held = [bar(1, 100, 10), bar(2, 100.5, 4)];
    expect(changeOf([], held)).toEqual({ kind: 'reset' });
    expect(changeOf(held, held)).toEqual({ kind: 'same' });
    expect(changeOf(held, [held[0]!, bar(2, 101, 6)])).toEqual({ kind: 'update', bars: [bar(2, 101, 6)] });
    expect(changeOf(held, [held[0]!, bar(2, 101, 6), bar(3, 99.5, 1)])).toEqual({
      kind: 'update',
      bars: [bar(2, 101, 6), bar(3, 99.5, 1)],
    });
    expect(changeOf(held, [bar(1, 99, 10), bar(2, 100.5, 4)])).toEqual({ kind: 'reset' });
    expect(changeOf(held, [held[0]!])).toEqual({ kind: 'reset' });
    expect(changeOf(held, [held[0]!, bar(5, 101, 6)])).toEqual({ kind: 'reset' });
  });
});

describe('reading older tick, range and volume bars', () => {
  const SESSION_MS = 86_400_000;
  const NOW = Date.UTC(2026, 10, 6);

  function paged(sessionsHeld: number) {
    const asked: number[] = [];
    const read = (input: GetPrintBarsInput): Promise<PrintBarsOutput> => {
      const sessions = input.sessions ?? 2;
      asked.push(sessions);
      const from = NOW - Math.min(sessions, sessionsHeld) * SESSION_MS;
      const candles = Array.from({ length: Math.min(sessions, sessionsHeld) * 10 }, (_, i) => {
        const t = (from + i * (SESSION_MS / 10)) * 1e6;
        return [t, 100, 101, 99, 100, 10, 5] as PrintBarsOutput['candles'][number];
      });
      return Promise.resolve({
        instrument: 'NQ',
        bars: input.bars,
        priceDecimals: 2,
        columns: ['t', 'o', 'h', 'l', 'c', 'v', 'bv'],
        candles,
        lastBarOpen: true,
        gaps: [],
        filling: false,
      });
    };
    const source = new PrintBarSource('NQ', { kind: 'volume', size: 1000 }, { read });
    const ends: HistoryEnd[] = [];
    const sink: BarsSink = {
      reset: () => undefined,
      update: () => undefined,
      prepend: () => undefined,
      live: () => undefined,
      error: () => undefined,
      olderRefused: () => undefined,
      ended: (end) => ends.push(end),
    };
    source.attach(sink);
    source.start();
    return { source, asked, ends };
  }

  it('asks for one more session at a time, and says so once the runtime builds no more', async () => {
    const p = paged(10);
    await vi.waitFor(() => expect(p.source.series.length).toBe(20));
    for (let sessions = 3; sessions <= MAX_PRINT_BAR_SESSIONS; sessions++) {
      p.source.pageOlder();
      await vi.waitFor(() => expect(p.source.series.length).toBe(sessions * 10));
    }
    expect(p.ends).toEqual([]);
    p.source.pageOlder();
    expect(p.ends).toEqual(['sessions']);
    expect(Math.max(...p.asked)).toBe(MAX_PRINT_BAR_SESSIONS);
    p.source.stop();
  });

  it('says history starts here when a wider read brings no older bars', async () => {
    const p = paged(2);
    await vi.waitFor(() => expect(p.source.series.length).toBe(20));
    p.source.pageOlder();
    await vi.waitFor(() => expect(p.ends).toEqual(['start']));
    expect(p.asked.at(-1)).toBe(3);
    p.source.stop();
  });
});
