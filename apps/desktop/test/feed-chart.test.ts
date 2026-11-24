import { createCanvas } from '@napi-rs/canvas';
import { createHeadlessChart } from '@tessera/chart';
import type { CandlesOutput, ContractSpec, GetCandlesInput } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChartFeed } from '../src/chart/feed.ts';
import { HistoryEdgeLayer } from '../src/chart/historyEdge.ts';
import { BarSources, SNAPSHOT_BARS } from '../src/market/bars.ts';
import { OLDER_HISTORY_REFUSED } from '../src/shell/deskWords.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { pause } from './support/pause.ts';
import { ns } from './support/time.ts';

const T0 = Date.parse('2026-09-28T09:30:00-04:00');

function output(n: number, base = 480): CandlesOutput {
  const bars: CandlesOutput['bars'] = [];
  for (let i = 0; i < n; i++) {
    const day = Math.floor(i / 78);
    const t = T0 + day * 86_400_000 + (i % 78) * 300_000;
    const p = base + Math.sin(i / 7) * 3;
    bars.push([ns(t), p, p + 0.4, p - 0.4, p + 0.1, 1000 + i]);
  }
  return {
    instrument: 'QQQ',
    tf: '5m',
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v'],
    bars,
    lastBarOpen: true,
    provider: 'mock-market',
  };
}

const spec = { tickSize: 0.01, sessions: 'us_equities', tz: 'America/New_York' } as ContractSpec;

describe('ChartFeed with the real chart engine', () => {
  it('keeps the view across a resubscribe refetch and a gap refetch', async () => {
    let bars = 300;
    const rt = fakeRuntime({ answers: { 'market.get_candles': () => output(bars) } });
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => T0 + 4 * 86_400_000,
      initialBars: 150,
    });
    const meta = vi.fn();
    const feed = new ChartFeed(chart, { onMeta: meta, sources: new BarSources({ keepMs: 0 }) });
    feed.load('QQQ', '5m', spec);
    const stream = await vi.waitFor(() => rt.sub('market.bars'));
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
    expect(chart.getViewport().following).toBe(true);

    chart.setViewport({ barSpacing: 3, rightEdgeSlot: 120 });
    const before = chart.getViewport();
    expect(before.following).toBe(false);

    bars = 301;
    stream.resubscribed();
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(2));
    let after = chart.getViewport();
    expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
    expect(after.toTime).toBe(before.toTime);
    expect(after.following).toBe(false);

    stream.gap();
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(3));
    after = chart.getViewport();
    expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
    expect(after.toTime).toBe(before.toTime);

    feed.dispose();
    chart.destroy();
  });

  it('draws nothing of the last timeframe or symbol while the next one is read', async () => {
    const rt = fakeRuntime();
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => T0 + 4 * 86_400_000,
      initialBars: 150,
    });
    const feed = new ChartFeed(chart, { sources: new BarSources({ keepMs: 0 }) });
    const snapshot = () =>
      vi.waitFor(() => {
        const read = rt.pending('market.get_candles');
        expect((read.input as GetCandlesInput).cachedOnly).toBeUndefined();
        return read;
      });
    const closes = () => {
      const s = chart.getSeries()!;
      return Array.from({ length: s.length }, (_, i) => Math.round(s.close[i]!));
    };

    feed.load('QQQ', '5m', spec);
    (await snapshot()).ok(output(300));
    await vi.waitFor(() => expect(closes()).toHaveLength(300));

    feed.load('QQQ', '15m', spec);
    expect(closes()).toEqual([]);
    (await snapshot()).ok(output(100));
    await vi.waitFor(() => expect(closes()).toHaveLength(100));

    feed.load('SPY', '15m', spec);
    expect(closes()).toEqual([]);
    (await snapshot()).ok(output(120, 650));
    await vi.waitFor(() => expect(closes()).toHaveLength(120));
    expect(Math.min(...closes())).toBeGreaterThan(600);

    feed.dispose();
    chart.destroy();
  });

  describe('history', () => {
    const ALL = output(78 * 40);
    const t = (i: number) => ALL.bars[i]![0] / 1e6;

    function candles(kept: { from: number }, calls: GetCandlesInput[]) {
      return (input: GetCandlesInput): CandlesOutput => {
        calls.push(input);
        const to = input.to === undefined ? Infinity : input.to / 1e6;
        let rows = ALL.bars.filter((b) => b[0] / 1e6 <= to);
        if (input.cachedOnly) rows = rows.filter((b) => b[0] / 1e6 >= kept.from && b[0] / 1e6 < t(ALL.bars.length - 6));
        rows = rows.slice(Math.max(0, rows.length - (input.limit ?? 500)));
        return { ...ALL, bars: rows };
      };
    }

    function setup(kept: { from: number }) {
      const calls: GetCandlesInput[] = [];
      const rt = fakeRuntime({ answers: { 'market.get_candles': candles(kept, calls) } });
      const chart = createHeadlessChart({
        width: 1200,
        height: 700,
        createCanvas: (w, h) => createCanvas(w, h),
        now: () => t(ALL.bars.length - 1),
        initialBars: 150,
      });
      const meta = vi.fn();
      const feed = new ChartFeed(chart, { onMeta: meta, sources: new BarSources({ keepMs: 0 }) });
      return { rt, chart, feed, meta, calls };
    }

    it('draws the snapshot once, keeping the older bars the kept read held', async () => {
      const kept = { from: t(78 * 10) };
      const h = setup(kept);
      h.feed.load('QQQ', '5m', spec);
      await vi.waitFor(() => expect(h.meta).toHaveBeenCalledTimes(1));
      const s = h.chart.getSeries()!;
      expect(s.length).toBe(ALL.bars.length - 78 * 10);
      expect(s.time[0]).toBe(kept.from);
      expect(s.time[s.length - 1]).toBe(t(ALL.bars.length - 1));
      expect(h.chart.getViewport().following).toBe(true);
      h.feed.dispose();
      h.chart.destroy();
    });

    it('prepends what the background fill keeps without moving the view', async () => {
      const kept = { from: t(78 * 36) };
      const h = setup(kept);
      h.feed.load('QQQ', '5m', spec);
      await vi.waitFor(() => expect(h.meta).toHaveBeenCalledTimes(1));
      const history = await vi.waitFor(() => h.rt.sub('market.history'));
      h.chart.setViewport({ barSpacing: 12, rightEdgeSlot: 280 });
      const before = h.chart.getViewport();
      const first = h.chart.getSeries()!.time[0]!;
      kept.from = t(ALL.bars.length - SNAPSHOT_BARS - 78 * 4);
      history.event({ instrument: 'QQQ', from: kept.from * 1e6, to: null, filling: true });
      await vi.waitFor(() => expect(h.chart.getSeries()!.time[0]).toBe(kept.from));
      const read = h.calls.at(-1)!;
      expect(read.cachedOnly).toBe(true);
      expect(read.to).toBe((first - 1) * 1e6);
      const after = h.chart.getViewport();
      expect(after.fromTime).toBe(before.fromTime);
      expect(after.toTime).toBe(before.toTime);
      expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
      const n = h.calls.length;
      history.event({ instrument: 'QQQ', from: kept.from * 1e6, to: null, filling: false });
      await pause();
      expect(h.calls).toHaveLength(n);
      h.feed.dispose();
      h.chart.destroy();
    });

    it('reads older pages as the view nears the first bar, until there are none', async () => {
      const kept = { from: Infinity };
      const h = setup(kept);
      h.feed.load('QQQ', '5m', spec);
      await vi.waitFor(() => expect(h.meta).toHaveBeenCalledTimes(1));
      const s = h.chart.getSeries()!;
      expect(s.length).toBe(SNAPSHOT_BARS);
      const first = s.time[0]!;
      h.chart.setViewport({ range: { from: first, to: s.time[100]! } });
      const shown = h.chart.getViewport();
      await vi.waitFor(() => expect(h.chart.getSeries()!.length).toBe(ALL.bars.length));
      const page = h.calls.at(-1)!;
      expect(page.cachedOnly).toBeUndefined();
      expect(page.to).toBe((first - 1) * 1e6);
      expect(page.limit).toBe(2_000);
      expect(h.chart.getViewport().toTime).toBe(shown.toTime);
      expect(h.chart.getViewport().barSpacing).toBeCloseTo(shown.barSpacing, 9);
      for (let i = 0; i < 2; i++) {
        const now = h.chart.getSeries()!;
        h.chart.setViewport({ range: { from: now.time[0]!, to: now.time[100]! } });
        await pause();
      }
      expect(h.chart.getSeries()!.length).toBe(ALL.bars.length);
      const n = h.calls.length;
      h.chart.setViewport({ range: { from: t(0), to: t(100) } });
      await pause();
      expect(h.calls).toHaveLength(n);
      h.feed.dispose();
      h.chart.destroy();
    });

    it("never mixes the last market's bars into the next one", async () => {
      const kept = { from: Infinity };
      const h = setup(kept);
      h.feed.load('QQQ', '5m', spec);
      await vi.waitFor(() => expect(h.meta).toHaveBeenCalledTimes(1));
      h.feed.load('SPY', '5m', spec);
      await vi.waitFor(() => expect(h.meta).toHaveBeenCalledTimes(2));
      expect(h.chart.getSeries()!.length).toBe(SNAPSHOT_BARS);
      h.feed.dispose();
      h.chart.destroy();
    });
  });

  describe('older history the feed refuses', () => {
    const ALL = output(78 * 40);
    const REFUSED = 'Rithmic refused the bar replay: permission denied (code 13)';

    async function waiting(rt: ReturnType<typeof fakeRuntime>, pick: (input: GetCandlesInput) => boolean) {
      return vi.waitFor(() => {
        const call = rt.toolCalls('market.get_candles').find((c) => !c.settled && pick(c.input as GetCandlesInput));
        if (!call) throw new Error('no such read waiting');
        return call;
      });
    }

    it('keeps the chart it drew, marks the left edge in plain words and asks no more', async () => {
      const rt = fakeRuntime();
      const chart = createHeadlessChart({
        width: 1200,
        height: 700,
        createCanvas: (w, h) => createCanvas(w, h),
        now: () => ALL.bars.at(-1)![0] / 1e6,
        initialBars: 150,
      });
      const edge = new HistoryEdgeLayer();
      chart.addLayer(edge);
      const meta = vi.fn();
      const onError = vi.fn();
      const feed = new ChartFeed(chart, {
        onMeta: meta,
        onError,
        onHistoryStop: (why) => edge.set(why),
        sources: new BarSources({ keepMs: 0 }),
      });
      feed.load('QQQ', '5m', spec);
      (await waiting(rt, (i) => i.cachedOnly === true)).ok({ ...ALL, bars: [] });
      (await waiting(rt, (i) => i.to === undefined)).ok({ ...ALL, bars: ALL.bars.slice(-SNAPSHOT_BARS) });
      await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
      const first = chart.getSeries()!.time[0]!;
      chart.setViewport({ range: { from: first, to: chart.getSeries()!.time[100]! } });
      (await waiting(rt, (i) => i.to !== undefined && !i.cachedOnly)).fail('unsupported', REFUSED);
      await vi.waitFor(() => expect(edge.current).toBe(OLDER_HISTORY_REFUSED));
      expect(onError).not.toHaveBeenCalled();
      expect(chart.getSeries()!.length).toBe(SNAPSHOT_BARS);

      const overlay = chart.canvases.overlay.getContext('2d') as { fillText: (t: string) => void };
      const said = vi.spyOn(overlay, 'fillText');
      chart.engine.render(true);
      expect(said.mock.calls.map((c) => c[0])).toContain(OLDER_HISTORY_REFUSED);

      const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      const asked = rt.toolCalls('market.get_candles').length;
      for (let i = 0; i < 3; i++) {
        chart.setViewport({ range: { from: first, to: chart.getSeries()!.time[100 + i]! } });
        await pause();
      }
      expect(rt.toolCalls('market.get_candles')).toHaveLength(asked);
      later.mockRestore();

      said.mockClear();
      chart.setViewport({ range: { from: chart.getSeries()!.time[1000]!, to: chart.getSeries()!.time[1200]! } });
      chart.engine.render(true);
      expect(said.mock.calls.map((c) => c[0])).not.toContain(OLDER_HISTORY_REFUSED);

      feed.load('SPY', '5m', spec);
      expect(edge.current).toBeNull();
      feed.dispose();
      chart.destroy();
    });
  });
});
