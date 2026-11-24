import { createCanvas } from '@napi-rs/canvas';
import { createHeadlessChart, type ChartApi } from '@tessera/chart';
import type { CandlesOutput, ContractSpec, GetCandlesInput } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { askOutcome, reportedView, viewToKeep, type HeldBars } from '../src/chart/askedView.ts';
import { ChartFeed } from '../src/chart/feed.ts';
import { BarSources, type HistoryEnd } from '../src/market/bars.ts';
import { viewShortWords } from '../src/shell/deskWords.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { ns } from './support/time.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-08-03T00:00:00Z');
const t = (i: number) => T0 + i * HOUR;
const ZONE = 'America/New_York';

const held = (count: number, first = t(0), last = t(count - 1)): HeldBars => ({
  count,
  first,
  last,
  lastEnd: last + HOUR,
});

describe('what a chart can show of what was asked', () => {
  it('meets an ask it holds enough for, keeps reading while older bars may come, and says why once they stop', () => {
    expect(askOutcome({ lastBars: 700 }, held(900), null)).toEqual({ kind: 'met' });
    expect(askOutcome({ lastBars: 900 }, held(351), null)).toEqual({ kind: 'reading' });
    const short = askOutcome({ lastBars: 900 }, held(351), 'sessions');
    expect(short).toEqual({ kind: 'short', short: { kind: 'bars', asked: 900, shown: 351, end: 'sessions' } });
    expect(askOutcome({ fitAll: true }, held(147), null)).toEqual({ kind: 'met' });
    expect(askOutcome({ range: { from: t(10), to: t(20) } }, held(100), null)).toEqual({ kind: 'met' });
    expect(askOutcome({ range: { from: t(-10), to: t(20) } }, held(100), null)).toEqual({ kind: 'reading' });
    expect(askOutcome({ range: { from: t(-10), to: t(20) } }, held(100), 'start')).toEqual({
      kind: 'short',
      short: { kind: 'from', asked: t(-10), first: t(0), end: 'start' },
    });
    expect(askOutcome({ range: { from: t(200), to: t(220) } }, held(100), null)).toEqual({
      kind: 'short',
      short: { kind: 'after', asked: t(200), last: t(99) },
    });
  });

  it('says it in a few plain words', () => {
    const said = (end: HistoryEnd) => viewShortWords({ kind: 'bars', asked: 900, shown: 351, end }, ZONE);
    expect(said('sessions')).toBe('351 of 900 bars: these bars reach back 5 sessions');
    expect(said('start')).toBe('351 of 900 bars: no older history');
    expect(said('refused')).toBe('351 of 900 bars: older history isn’t available on this login');
    expect(said('cap')).toBe('351 of 900 bars: a chart holds 50,000 bars at most');
    const day = (iso: string) => Date.parse(iso);
    expect(
      viewShortWords(
        { kind: 'from', asked: day('2026-10-22T12:00:00Z'), first: day('2026-10-30T12:00:00Z'), end: 'start' },
        ZONE,
      ),
    ).toBe('From Oct 30, not Oct 22: no older history');
    expect(
      viewShortWords({ kind: 'after', asked: day('2026-10-22T12:00:00Z'), last: day('2026-10-20T12:00:00Z') }, ZONE),
    ).toBe('Nothing from Oct 22 yet: the last bar is Oct 20');
    for (const end of ['sessions', 'start', 'refused', 'cap'] as const)
      expect(said(end)).not.toMatch(/\w+_\w+|\[\d+\]/);
  });

  it('keeps an ask, a followed view or a span for the chart to show again', () => {
    const times = [t(0), t(1), t(2), t(3)];
    const base = { barSpacing: 6, rightEdgeSlot: 3, from: 0, to: 3, fromTime: t(0), toTime: t(3) };
    const vp = { ...base, priceMin: 1, priceMax: 2, priceMode: 'auto' as const, shown: { from: 1, to: 3 } };
    expect(viewToKeep({ ...vp, following: true, asked: { lastBars: 900 } }, times)).toEqual({ lastBars: 900 });
    expect(viewToKeep({ ...vp, following: true, asked: null }, times)).toEqual({ lastBars: 3 });
    expect(viewToKeep({ ...vp, following: false, asked: null }, times)).toEqual({ range: { from: t(1), to: t(3) } });
    const reported = { from: ns(t(1)), to: ns(t(3)), priceMin: null, priceMax: null, reportedAt: ns(t(4)) };
    expect(reportedView({ ...reported, bars: 700, follows: true })).toEqual({ lastBars: 700 });
    expect(reportedView({ ...reported, bars: 3 })).toEqual({ range: { from: t(1), to: t(3) } });
    expect(reportedView({ ...reported, bars: null })).toBeNull();
  });
});

describe('a chart asked for more than it holds', () => {
  const HELD = 600;
  const PAGE = 250;

  function candles(input: GetCandlesInput): CandlesOutput {
    const to = input.to === undefined ? Infinity : input.to / 1e6;
    const all = Array.from({ length: HELD }, (_, i) => i).filter((i) => t(i) <= to && !input.cachedOnly);
    const page = all.slice(Math.max(0, all.length - Math.min(input.limit ?? PAGE, PAGE)));
    return {
      instrument: 'NQZ6.CME',
      tf: '1h',
      priceDecimals: 2,
      tz: ZONE,
      columns: ['t', 'o', 'h', 'l', 'c', 'v'],
      bars: page.map((i) => [ns(t(i)), 20000 + i, 20010 + i, 19990 + i, 20001 + i, 1000]),
      lastBarOpen: true,
      provider: 'mock',
    };
  }

  function charted() {
    fakeRuntime({ answers: { 'market.get_candles': candles } });
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => t(HELD),
      initialBars: 150,
    });
    let end: HistoryEnd | null = null;
    const feed = new ChartFeed(chart, { sources: new BarSources({ keepMs: 0 }), onHistoryEnd: (e) => (end = e) });
    feed.load('NQ', '1h', { tickSize: 0.25, sessions: 'cme_equity_index', tz: ZONE } as ContractSpec);
    const outcome = () => {
      const s = chart.getSeries()!;
      const n = s.length;
      const asked = chart.getViewport().asked!;
      return askOutcome(
        asked,
        { count: n, first: s.time[0]!, last: s.time[n - 1]!, lastEnd: s.time[n - 1]! + HOUR },
        end,
      );
    };
    const shownBars = (c: ChartApi) => {
      c.render(true);
      const s = c.getViewport().shown!;
      return s.to - s.from + 1;
    };
    return { chart, feed, outcome, shown: () => shownBars(chart) };
  }

  it('reads older pages until it shows the bars asked for', async () => {
    const c = charted();
    await vi.waitFor(() => expect(c.chart.getSeries()!.length).toBe(PAGE));
    c.chart.setViewport({ lastBars: 450 });
    await vi.waitFor(() => expect(c.outcome()).toEqual({ kind: 'met' }));
    expect(c.shown()).toBe(450);
    c.feed.dispose();
    c.chart.destroy();
  });

  it('shows every bar it could read and says why it has no more', async () => {
    const c = charted();
    await vi.waitFor(() => expect(c.chart.getSeries()!.length).toBe(PAGE));
    c.chart.setViewport({ lastBars: 900 });
    await vi.waitFor(() =>
      expect(c.outcome()).toEqual({ kind: 'short', short: { kind: 'bars', asked: 900, shown: HELD, end: 'start' } }),
    );
    expect(c.shown()).toBe(HELD);
    c.feed.dispose();
    c.chart.destroy();
  });
});
