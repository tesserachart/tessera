import { SeriesStore } from '@tessera/chart';
import {
  timeframeMs,
  type BarUpdate,
  type CandlesOutput,
  type ContractSpec,
  type SessionsOutput,
  type Timeframe,
} from '@tessera/protocol';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ChartFeed, type FeedChart } from '../src/chart/feed.ts';
import { SightSwitch } from '../src/app/inSight.ts';
import { BarSources, toBarTuple, READ_RETRY, WARM_TIMEFRAMES } from '../src/market/bars.ts';
import { OLDER_HISTORY_REFUSED } from '../src/shell/deskWords.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { pause } from './support/pause.ts';
import { ns } from './support/time.ts';
import simCandles from './fixtures/sim-candles.json' with { type: 'json' };

const T0 = Date.parse('2026-10-02T14:30:00-04:00');

function output(n: number): CandlesOutput {
  return {
    instrument: 'NQZ6.CME',
    tf: '5m',
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v'],
    bars: Array.from({ length: n }, (_, i) => [ns(T0 + i * 300_000), 20640, 20650, 20630, 20641.25, 1000]),
    lastBarOpen: true,
    provider: 'rithmic-test',
  };
}

const spec = { tickSize: 0.25, sessions: 'cme_equity_index', tz: 'America/New_York' } as ContractSpec;

const chartSpy = () =>
  ({
    setData: vi.fn(),
    update: vi.fn(),
    setOptions: vi.fn(),
    prepend: vi.fn(() => 0),
    on: vi.fn(() => () => undefined),
  }) satisfies FeedChart;

function rows(bars: unknown): unknown[] {
  if (!(bars instanceof SeriesStore)) return bars as unknown[];
  return Array.from({ length: bars.length }, (_, i) => {
    const b = bars.bar(i);
    return b.bv === undefined ? [b.t, b.o, b.h, b.l, b.c, b.v] : [b.t, b.o, b.h, b.l, b.c, b.v, b.bv];
  });
}

const snapshots = (rt: ReturnType<typeof fakeRuntime>) =>
  rt.toolCalls('market.get_candles').filter((c) => !(c.input as { cachedOnly?: boolean }).cachedOnly);

function harness(
  keep: ConstructorParameters<typeof BarSources>[0] = { keepMs: 0 },
  answers?: Parameters<typeof fakeRuntime>[0],
) {
  const rt = fakeRuntime(answers);
  const sources = new BarSources(keep);
  return {
    rt,
    sources,
    chart: chartSpy(),
    bars: () => vi.waitFor(() => rt.sub('market.bars')),
    read: () => vi.waitFor(() => rt.pending('market.get_candles')),
  };
}

describe('toBarTuple', () => {
  it('converts wire bars and keeps buy volume only when sent', () => {
    expect(toBarTuple([ns(T0), 1, 2, 0.5, 1.5, 10])).toEqual([T0, 1, 2, 0.5, 1.5, 10]);
    expect(toBarTuple([ns(T0), 1, 2, 0.5, 1.5, 10, 4])).toEqual([T0, 1, 2, 0.5, 1.5, 10, 4]);
  });
});

describe('ChartFeed', () => {
  it('subscribes before fetching, buffers early events and replays them after the snapshot', async () => {
    const h = harness();
    const meta = vi.fn();
    const feed = new ChartFeed(h.chart, { onMeta: meta, sources: h.sources });
    feed.load('NQ', '5m', spec);
    const bars = await h.bars();
    expect(bars.params).toEqual({ instrument: 'NQ', tf: '5m' });
    const early: BarUpdate = {
      instrument: 'NQZ6.CME',
      tf: '5m',
      bar: [ns(T0 + 600_000), 20641, 20645, 20640, 20644, 12],
      closed: false,
      source: { provider: 'rithmic-test' },
    };
    bars.event(early);
    const read = await h.read();
    expect(read.input).toEqual({ instrument: 'NQ', tf: '5m', limit: 1500 });
    expect(h.rt.toolCalls('market.get_candles')[0]!.input).toEqual({
      instrument: 'NQ',
      tf: '5m',
      limit: 5000,
      cachedOnly: true,
    });
    await vi.waitFor(() => expect(h.rt.sub('market.history').params).toEqual({ instrument: 'NQ', tf: '5m' }));
    expect(h.chart.update).not.toHaveBeenCalled();
    read.ok(output(3));
    await vi.waitFor(() => expect(meta).toHaveBeenCalled());
    expect(h.chart.update).not.toHaveBeenCalled();
    expect(h.chart.setOptions).toHaveBeenCalledWith({
      priceFormat: { precision: 2, minMove: 0.25 },
      sessions: {
        mode: 'continuous',
        timezone: 'America/New_York',
        dayStartMinutes: 1080,
        dayStartZone: 'America/New_York',
      },
      timeframeMs: 300_000,
    });
    expect(h.chart.setData).toHaveBeenCalledWith('main', expect.any(SeriesStore), { keepView: false });
    const drawn = rows(h.chart.setData.mock.calls[0]![1]);
    expect(drawn[0]).toEqual([T0, 20640, 20650, 20630, 20641.25, 1000]);
    expect(drawn.at(-1)).toEqual(toBarTuple(early.bar));
    bars.event({ ...early, bar: [ns(T0 + 900_000), 20644, 20644, 20644, 20644, 1] });
    await vi.waitFor(() => expect(h.chart.update).toHaveBeenCalledTimes(1));
    expect(h.chart.update).toHaveBeenCalledWith('main', [T0 + 900_000, 20644, 20644, 20644, 20644, 1]);
    expect(meta.mock.calls[0]![0]).toMatchObject({
      instrument: 'NQZ6.CME',
      source: { provider: 'rithmic-test' },
      bars: 3,
    });
    feed.dispose();
  });

  it('infers sessions and tick from the candles when there is no spec; names the connection', async () => {
    const h = harness();
    const meta = vi.fn();
    const feed = new ChartFeed(h.chart, { onMeta: meta, sources: h.sources });
    feed.load('QQQ', '1m', null);
    (await h.read()).ok(output(2));
    await vi.waitFor(() => expect(meta).toHaveBeenCalled());
    expect(h.chart.setOptions.mock.calls[0]![0]).toMatchObject({
      priceFormat: { precision: 2, minMove: 0.01 },
      sessions: { mode: 'continuous' },
    });
    expect(meta.mock.calls[0]![0].source).toEqual({ provider: 'rithmic-test' });
    feed.dispose();
  });

  it('ignores other timeframes, and lets the last market go when it switches or is disposed', async () => {
    const h = harness();
    const feed = new ChartFeed(h.chart, { sources: h.sources });
    feed.load('QQQ', '5m', spec);
    feed.load('QQQ', '5m', spec);
    const bars = await h.bars();
    (await h.read()).ok(output(3));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalled());
    expect(h.rt.subscriptions.filter((x) => x.topic === 'market.bars')).toHaveLength(1);
    bars.event({
      instrument: 'QQQ',
      tf: '1m',
      bar: [ns(T0), 1, 1, 1, 1, 1],
      closed: false,
      source: { provider: 'rithmic-test' },
    });
    const shown: BarUpdate = {
      instrument: 'QQQ',
      tf: '5m',
      bar: [ns(T0 + 900_000), 2, 2, 2, 2, 2],
      closed: false,
      source: { provider: 'rithmic-test' },
    };
    bars.event(shown);
    await vi.waitFor(() => expect(h.chart.update).toHaveBeenCalled());
    expect(h.chart.update.mock.calls).toEqual([['main', toBarTuple(shown.bar)]]);
    feed.load('SPY', '1m', spec);
    await vi.waitFor(() => expect(bars.open).toBe(false));
    const spy = await h.bars();
    expect(spy.params).toEqual({ instrument: 'SPY', tf: '1m' });
    const late = await h.read();
    feed.dispose();
    await vi.waitFor(() => expect(spy.open).toBe(false));
    late.ok(output(5));
    await pause();
    expect(h.chart.setData).toHaveBeenCalledTimes(2);
    expect(h.chart.setData).toHaveBeenLastCalledWith('main', []);
  });

  it('refetches keeping the view after a resubscribe; gap refetches are throttled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = harness();
      const feed = new ChartFeed(h.chart, { sources: h.sources });
      feed.load('QQQ', '5m', spec);
      const bars = await h.bars();
      (await h.read()).ok(output(3));
      await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
      bars.resubscribed();
      (await h.read()).ok(output(3));
      await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(2));
      expect(h.chart.setData.mock.calls[1]![2]).toEqual({ keepView: true });
      bars.gap();
      (await h.read()).ok(output(3));
      await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(3));
      bars.gap();
      await pause();
      expect(snapshots(h.rt)).toHaveLength(3);
      vi.advanceTimersByTime(5_000);
      bars.gap();
      (await h.read()).ok(output(3));
      await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(4));
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws a read that answers a minute late though gaps keep coming, then reads once more and stays live meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const meta = vi.fn();
      const feed = new ChartFeed(h.chart, { onMeta: meta, sources: h.sources });
      feed.load('NQ', '5m', spec);
      const bars = await h.bars();
      const first = await h.read();
      for (let s = 0; s < 60; s += 5) {
        await vi.advanceTimersByTimeAsync(5_000);
        bars.gap();
      }
      expect(snapshots(h.rt)).toHaveLength(1);
      first.ok(output(3));
      await vi.waitFor(() => expect(meta).toHaveBeenCalled());
      expect(h.chart.setData).toHaveBeenCalledTimes(1);
      expect(snapshots(h.rt)).toHaveLength(2);
      const tick: BarUpdate = {
        instrument: 'NQZ6.CME',
        tf: '5m',
        bar: [ns(T0 + 900_000), 20644, 20644, 20644, 20644, 1],
        closed: false,
        source: { provider: 'rithmic-test' },
      };
      bars.event(tick);
      expect(h.chart.update).toHaveBeenCalledWith('main', toBarTuple(tick.bar));
      h.rt.pending('market.get_candles').ok(output(3));
      await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(2));
      expect(rows(h.chart.setData.mock.calls[1]![1]).at(-1)).toEqual(toBarTuple(tick.bar));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(snapshots(h.rt)).toHaveLength(2);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports tool failures', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const onError = vi.fn();
      const feed = new ChartFeed(h.chart, { onError, sources: h.sources });
      feed.load('ZZZ', '5m', null);
      (await h.read()).fail('not_found', 'unknown instrument');
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());
      expect(onError.mock.calls[0]![0].message).toContain('unknown instrument');
      await vi.advanceTimersByTimeAsync(READ_RETRY.maxDelayMs);
      expect(snapshots(h.rt)).toHaveLength(1);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a refused stream', async () => {
    const h = harness();
    const onError = vi.fn();
    const feed = new ChartFeed(h.chart, { onError, sources: h.sources });
    feed.load('ZZZ', '5m', null);
    (await h.bars()).refuse('unknown instrument ZZZ');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0]![0].message).toContain('unknown instrument ZZZ');
    feed.dispose();
  });

  it('asks again by itself while the connection serving the chart is still logging in', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const onError = vi.fn();
      const meta = vi.fn();
      const feed = new ChartFeed(h.chart, { onError, onMeta: meta, sources: h.sources });
      feed.load('NQZ6.CME-RITHMIC', '5m', spec);
      (await h.read()).fail('unavailable', 'connecting to Rithmic', { retryable: true });
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());
      expect(onError.mock.calls[0]![0].message).toContain('connecting to Rithmic');
      expect(snapshots(h.rt)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(READ_RETRY.initialDelayMs);
      expect(snapshots(h.rt)).toHaveLength(2);
      h.rt.pending('market.get_candles').ok(output(3));
      await vi.waitFor(() => expect(meta).toHaveBeenCalled());
      expect(h.rt.subscriptions.filter((x) => x.topic === 'market.bars')).toHaveLength(1);
      feed.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(snapshots(h.rt)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again by itself when a read’s answer never came, and says nothing failed meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const onError = vi.fn();
      const meta = vi.fn();
      const feed = new ChartFeed(h.chart, { onError, onMeta: meta, sources: h.sources });
      feed.load('NQZ6.CME-RITHMIC', '5m', spec);
      (await h.read()).timedOut();
      await vi.advanceTimersByTimeAsync(READ_RETRY.maxDelayMs);
      expect(snapshots(h.rt)).toHaveLength(2);
      h.rt.pending('market.get_candles').timedOut();
      await vi.advanceTimersByTimeAsync(READ_RETRY.maxDelayMs);
      expect(snapshots(h.rt)).toHaveLength(3);
      h.rt.pending('market.get_candles').ok(output(3));
      await vi.waitFor(() => expect(meta).toHaveBeenCalled());
      expect(onError).not.toHaveBeenCalled();
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

const lastLoading = (onLoading: Mock<(loading: boolean) => void>) => onLoading.mock.calls.at(-1)?.[0];

describe('ChartFeed loading', () => {
  const keptRead = (h: ReturnType<typeof harness>) =>
    vi.waitFor(() => {
      const call = h.rt.toolCalls('market.get_candles').find((c) => (c.input as { cachedOnly?: boolean }).cachedOnly);
      if (!call) throw new Error('no kept read yet');
      return call;
    });
  const keptIn = (h: ReturnType<typeof harness>, bars: number) =>
    vi.waitFor(() => {
      const held = h.sources.acquire('NQ', '5m');
      const length = held.source.series.length;
      held.release();
      expect(length).toBe(bars);
    });

  async function drawn() {
    const h = harness();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(h.chart, { onLoading, sources: h.sources });
    feed.load('NQ', '5m', spec);
    (await h.read()).ok(output(3));
    await vi.waitFor(() => expect(lastLoading(onLoading)).toBe(false));
    return { h, feed, onLoading };
  }

  it('draws nothing from the kept bars alone and reports loading', async () => {
    const h = harness();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const meta = vi.fn();
    const feed = new ChartFeed(h.chart, { onLoading, onMeta: meta, sources: h.sources });
    feed.load('NQ', '5m', spec);
    const kept = await keptRead(h);
    kept.ok(output(2));
    await keptIn(h, 2);
    expect(h.chart.setData).not.toHaveBeenCalled();
    expect(h.chart.update).not.toHaveBeenCalled();
    expect(onLoading.mock.calls.map((c) => c[0])).toEqual([true]);
    expect(meta).not.toHaveBeenCalled();
    feed.dispose();
  });

  it('draws once with the full fetched series and reports loaded', async () => {
    const h = harness();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(h.chart, { onLoading, sources: h.sources });
    feed.load('NQ', '5m', spec);
    (await keptRead(h)).ok(output(2));
    await keptIn(h, 2);
    (await h.read()).ok(output(5));
    await vi.waitFor(() => expect(lastLoading(onLoading)).toBe(false));
    expect(h.chart.setData).toHaveBeenCalledTimes(1);
    expect(rows(h.chart.setData.mock.calls[0]![1])).toHaveLength(5);
    expect(h.chart.setData.mock.calls[0]![2]).toEqual({ keepView: false });
    expect(onLoading.mock.calls.map((c) => c[0])).toEqual([true, false]);
    feed.dispose();
  });

  it('draws the kept bars once when the read fails, and tells the error', async () => {
    const h = harness();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const onError = vi.fn();
    const feed = new ChartFeed(h.chart, { onLoading, onError, sources: h.sources });
    feed.load('NQ', '5m', spec);
    (await keptRead(h)).ok(output(2));
    await keptIn(h, 2);
    (await h.read()).fail('not_found', 'unknown instrument');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(h.chart.setData).toHaveBeenCalledTimes(1);
    expect(rows(h.chart.setData.mock.calls[0]![1])).toHaveLength(2);
    expect(lastLoading(onLoading)).toBe(false);
    feed.dispose();
  });

  it('keeps the kept bars with a history stop and no error when the feed refuses the read, and never asks it again', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const onLoading = vi.fn<(loading: boolean) => void>();
      const onError = vi.fn();
      const onHistoryStop = vi.fn();
      const feed = new ChartFeed(h.chart, { onLoading, onError, onHistoryStop, sources: h.sources });
      feed.load('NQ', '5m', spec);
      (await keptRead(h)).ok(output(2));
      await keptIn(h, 2);
      (await h.read()).fail('unavailable', 'request rejected: [13] permission denied');
      await vi.waitFor(() => expect(onHistoryStop).toHaveBeenLastCalledWith(OLDER_HISTORY_REFUSED));
      expect(onError).not.toHaveBeenCalled();
      expect(h.chart.setData).toHaveBeenCalledTimes(1);
      expect(rows(h.chart.setData.mock.calls[0]![1])).toHaveLength(2);
      expect(lastLoading(onLoading)).toBe(false);
      await vi.advanceTimersByTimeAsync(READ_RETRY.maxDelayMs * 4);
      expect(snapshots(h.rt)).toHaveLength(1);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the error down and marks the history stop when kept bars arrive after the feed refused the read', async () => {
    const h = harness();
    const onError = vi.fn();
    const onHistoryStop = vi.fn();
    const feed = new ChartFeed(h.chart, { onError, onHistoryStop, sources: h.sources });
    feed.load('NQ', '5m', spec);
    const kept = await keptRead(h);
    (await h.read()).fail('unavailable', 'request rejected: [13] permission denied');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    kept.ok(output(2));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    expect(rows(h.chart.setData.mock.calls[0]![1])).toHaveLength(2);
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(onHistoryStop).toHaveBeenLastCalledWith(OLDER_HISTORY_REFUSED);
    feed.dispose();
  });

  it('keeps saying a chart did not load when bars arrive after a failure that was not a refusal', async () => {
    const h = harness();
    const onError = vi.fn();
    const onHistoryStop = vi.fn();
    const feed = new ChartFeed(h.chart, { onError, onHistoryStop, sources: h.sources });
    feed.load('NQ', '5m', spec);
    const kept = await keptRead(h);
    (await h.read()).fail('not_found', 'unknown instrument');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    kept.ok(output(2));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onHistoryStop).not.toHaveBeenCalledWith(OLDER_HISTORY_REFUSED);
    feed.dispose();
  });

  it('still says a chart the feed refused did not load when it has nothing to show', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const onError = vi.fn();
      const onHistoryStop = vi.fn();
      const feed = new ChartFeed(h.chart, { onError, onHistoryStop, sources: h.sources });
      feed.load('NQ', '5m', spec);
      (await keptRead(h)).ok({ ...output(0) });
      (await h.read()).fail('unavailable', 'request rejected: [13] permission denied');
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onError.mock.calls[0]![0].message).toContain('permission denied');
      expect(onHistoryStop).not.toHaveBeenCalledWith(OLDER_HISTORY_REFUSED);
      expect(h.chart.setData).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(READ_RETRY.maxDelayMs * 4);
      expect(snapshots(h.rt)).toHaveLength(1);
      feed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops loading when the read fails and there is nothing to draw, then draws when a later read answers', async () => {
    const h = harness();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const onError = vi.fn();
    const feed = new ChartFeed(h.chart, { onLoading, onError, sources: h.sources });
    feed.load('ZZZ', '5m', null);
    (await h.read()).fail('not_found', 'unknown instrument');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(lastLoading(onLoading)).toBe(false);
    expect(h.chart.setData).not.toHaveBeenCalled();
    feed.reload();
    (await h.read()).ok(output(3));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    expect(h.chart.setData.mock.calls[0]![2]).toEqual({ keepView: false });
    expect(lastLoading(onLoading)).toBe(false);
    feed.dispose();
  });

  it('reports loading again for a new symbol, clears the old one, and reports loaded when its bars are in', async () => {
    const { h, feed, onLoading } = await drawn();
    feed.load('ES', '5m', spec);
    expect(lastLoading(onLoading)).toBe(true);
    expect(h.chart.setData).toHaveBeenLastCalledWith('main', []);
    (await h.read()).ok(output(4));
    await vi.waitFor(() => expect(lastLoading(onLoading)).toBe(false));
    expect(rows(h.chart.setData.mock.calls.at(-1)![1])).toHaveLength(4);
    feed.dispose();
  });

  it('never goes back to loading when a drawn chart reloads or its stream comes back', async () => {
    const { h, feed, onLoading } = await drawn();
    const bars = await h.bars();
    const calls = onLoading.mock.calls.length;
    feed.reload();
    (await h.read()).ok(output(4));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(2));
    bars.resubscribed();
    (await h.read()).ok(output(5));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(3));
    expect(onLoading.mock.calls).toHaveLength(calls);
    expect(h.chart.setData.mock.calls[2]![2]).toEqual({ keepView: true });
    feed.dispose();
  });

  it('shows a print-bar chart only once its read has answered', async () => {
    const rt = fakeRuntime();
    const chart = chartSpy();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(chart, { onLoading });
    feed.load('NQ', '5m', spec, { kind: 'tick', size: 100 });
    const read = await vi.waitFor(() => rt.pending('market.get_print_bars'));
    expect(lastLoading(onLoading)).toBe(true);
    expect(chart.setData).not.toHaveBeenCalled();
    read.ok({
      instrument: 'NQZ6.CME',
      bars: { kind: 'tick', size: 100 },
      priceDecimals: 2,
      columns: ['t', 'o', 'h', 'l', 'c', 'v'],
      candles: [[ns(T0), 1, 2, 0.5, 1.5, 10]],
      lastBarOpen: true,
      gaps: [],
      filling: false,
    });
    await vi.waitFor(() => expect(lastLoading(onLoading)).toBe(false));
    expect(rows(chart.setData.mock.calls[0]![1])).toHaveLength(1);
    feed.dispose();
  });

  it('stops loading a print-bar chart whose read fails', async () => {
    const rt = fakeRuntime();
    const chart = chartSpy();
    const onLoading = vi.fn<(loading: boolean) => void>();
    const onError = vi.fn();
    const feed = new ChartFeed(chart, { onLoading, onError });
    feed.load('NQ', '5m', spec, { kind: 'range', size: 4 });
    (await vi.waitFor(() => rt.pending('market.get_print_bars'))).fail('not_found', 'no prints');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(lastLoading(onLoading)).toBe(false);
    expect(chart.setData).not.toHaveBeenCalled();
    feed.dispose();
  });
});

describe('shared markets', () => {
  it('reads and streams a market once for every chart that shows it', async () => {
    const h = harness({ keepMs: 60_000 });
    const a = chartSpy();
    const b = chartSpy();
    const metaB = vi.fn();
    const feedA = new ChartFeed(a, { sources: h.sources });
    feedA.load('NQ', '5m', spec);
    const bars = await h.bars();
    (await h.read()).ok(output(3));
    await vi.waitFor(() => expect(a.setData).toHaveBeenCalled());
    const feedB = new ChartFeed(b, { onMeta: metaB, sources: h.sources });
    feedB.load('NQ', '5m', spec);
    expect(b.setData).toHaveBeenCalledWith('main', expect.any(SeriesStore), { keepView: false });
    expect(rows(b.setData.mock.calls[0]![1])).toHaveLength(3);
    expect(metaB).toHaveBeenCalledWith(expect.objectContaining({ instrument: 'NQZ6.CME', bars: 3 }));
    expect(snapshots(h.rt)).toHaveLength(1);
    expect(h.rt.subscriptions.filter((x) => x.topic === 'market.bars')).toHaveLength(1);
    bars.event({
      instrument: 'NQZ6.CME',
      tf: '5m',
      bar: [ns(T0 + 900_000), 1, 1, 1, 1, 1],
      closed: false,
      source: { provider: 'rithmic-test' },
    });
    await vi.waitFor(() => expect(b.update).toHaveBeenCalledOnce());
    expect(a.update).toHaveBeenCalledOnce();
    feedA.dispose();
    feedB.dispose();
    h.sources.clear();
  });

  it('keeps a market live after its last chart goes, so the next chart draws it from memory', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ keepMs: 60_000, maxIdle: 1 });
      const first = new ChartFeed(h.chart, { sources: h.sources });
      first.load('NQ', '5m', spec);
      const bars = await h.bars();
      (await h.read()).ok(output(3));
      await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalled());
      first.dispose();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bars.open).toBe(true);
      expect(h.sources.idle).toBe(1);
      bars.event({
        instrument: 'NQZ6.CME',
        tf: '5m',
        bar: [ns(T0 + 900_000), 1, 2, 0.5, 1.5, 7],
        closed: false,
        source: { provider: 'rithmic-test' },
      });
      await vi.advanceTimersByTimeAsync(10);
      const back = chartSpy();
      const again = new ChartFeed(back, { sources: h.sources });
      again.load('NQ', '5m', spec);
      const drawn = rows(back.setData.mock.calls[0]![1]);
      expect(drawn).toHaveLength(4);
      expect(drawn.at(-1)).toEqual([T0 + 900_000, 1, 2, 0.5, 1.5, 7]);
      expect(snapshots(h.rt)).toHaveLength(1);
      expect(h.rt.subscriptions.filter((x) => x.topic === 'market.bars')).toHaveLength(1);
      expect(h.sources.idle).toBe(0);
      again.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bars.open).toBe(false);
      expect(h.sources.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most so many markets nobody shows, the one idle longest going first', async () => {
    const h = harness({ keepMs: 60_000, maxIdle: 1 });
    const feed = new ChartFeed(h.chart, { sources: h.sources });
    feed.load('NQ', '5m', spec);
    const nq = await h.bars();
    feed.load('ES', '5m', spec);
    await vi.waitFor(() => expect(h.rt.subscriptions.filter((x) => x.topic === 'market.bars')).toHaveLength(2));
    expect(nq.open).toBe(true);
    feed.load('YM', '5m', spec);
    await vi.waitFor(() => expect(nq.open).toBe(false));
    expect(h.sources.idle).toBe(1);
    expect(h.sources.size).toBe(2);
    feed.dispose();
    h.sources.clear();
  });
});

const PRICE_OF: Record<Timeframe, number> = {
  '1s': 90,
  '1m': 100,
  '5m': 200,
  '15m': 300,
  '30m': 400,
  '1h': 500,
  '4h': 600,
  '1D': 700,
};

function candlesOf(tf: Timeframe, n = 4): CandlesOutput {
  const base = PRICE_OF[tf] ?? 0;
  return {
    ...output(0),
    tf,
    bars: Array.from({ length: n }, (_, i) => [
      ns(T0 + i * timeframeMs(tf)),
      base + i,
      base + i + 5,
      base + i - 5,
      base + i + 1,
      1000 * (i + 1),
    ]),
  };
}

const wireBars = (tf: Timeframe, n = 4) => candlesOf(tf, n).bars.map((b) => toBarTuple(b));

const answerEveryTimeframe: Parameters<typeof fakeRuntime>[0] = {
  answers: { 'market.get_candles': (input) => candlesOf(input.tf) },
};

const barsTopic = (rt: ReturnType<typeof fakeRuntime>, tf: Timeframe) => {
  const found = rt.subscriptions.find(
    (s) => s.topic === 'market.bars' && s.open && (s.params as { tf: string }).tf === tf,
  );
  if (!found) throw new Error(`no open market.bars subscription for ${tf}`);
  return found;
};

const tfsOf = (rt: ReturnType<typeof fakeRuntime>, topic: string) =>
  rt.subscriptions.filter((s) => s.topic === topic).map((s) => (s.params as { tf: string }).tf);

const answerOf = (rt: ReturnType<typeof fakeRuntime>, tf: Timeframe) =>
  vi.waitFor(() => {
    const call = rt
      .toolCalls('market.get_candles')
      .find(
        (c) =>
          !c.settled &&
          (c.input as { tf: string; cachedOnly?: boolean }).tf === tf &&
          !(c.input as { cachedOnly?: boolean }).cachedOnly,
      );
    if (!call) throw new Error(`no snapshot read of ${tf} waiting`);
    return call;
  });

const keptOf = (h: ReturnType<typeof harness>, tf: Timeframe) =>
  vi.waitFor(() => {
    const call = h.rt
      .toolCalls('market.get_candles')
      .find(
        (c) =>
          !c.settled &&
          (c.input as { tf: string; cachedOnly?: boolean }).tf === tf &&
          (c.input as { cachedOnly?: boolean }).cachedOnly,
      );
    if (!call) throw new Error(`no kept read of ${tf} waiting`);
    return call;
  });

const allSettled = (h: ReturnType<typeof harness>, instrument: string) =>
  vi.waitFor(() => {
    for (const tf of WARM_TIMEFRAMES) {
      const held = h.sources.acquire(instrument, tf);
      const settled = held.source.settled;
      held.release();
      expect(settled, `${instrument} ${tf} settled`).toBe(true);
    }
  });

describe('ChartFeed timeframe switch', () => {
  it('draws the new timeframe inside load when its source is warm, with no clear and no loading in between', async () => {
    const h = harness({ keepMs: 60_000 }, answerEveryTimeframe);
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(h.chart, { onLoading, sources: h.sources, warm: true });
    feed.load('NQ', '1m', spec);
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    await allSettled(h, 'NQ');
    const reads = snapshots(h.rt).length;
    expect(rows(h.chart.setData.mock.calls[0]![1])).toEqual(wireBars('1m'));
    for (const tf of ['5m', '15m', '1m'] as const) {
      const before = h.chart.setData.mock.calls.length;
      feed.load('NQ', tf, spec);
      expect(h.chart.setData).toHaveBeenCalledTimes(before + 1);
      const [series, bars, keep] = h.chart.setData.mock.calls.at(-1)!;
      expect(series).toBe('main');
      expect(rows(bars)).toEqual(wireBars(tf));
      expect(keep).toEqual({ keepView: false });
      expect(h.chart.setOptions).toHaveBeenLastCalledWith(expect.objectContaining({ timeframeMs: timeframeMs(tf) }));
    }
    expect(h.chart.setData.mock.calls.every((c) => rows(c[1]).length > 0)).toBe(true);
    expect(onLoading.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(snapshots(h.rt)).toHaveLength(reads);
    feed.dispose();
    h.sources.clear();
  });

  it('draws exactly the runtime’s own 5m and 15m, each the roll-up of its minutes, on the switch from 1m', async () => {
    const sim = simCandles.reads as Record<'1m' | '5m' | '15m', CandlesOutput>;
    const h = harness(
      { keepMs: 60_000 },
      {
        answers: {
          'market.get_candles': (input) => (input.tf in sim ? sim[input.tf as keyof typeof sim] : candlesOf(input.tf)),
        },
      },
    );
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(h.chart, { onLoading, sources: h.sources, warm: true });
    feed.load(simCandles.instrument, '1m', spec);
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    await allSettled(h, simCandles.instrument);
    const minutes = sim['1m'].bars.map(toBarTuple);
    for (const tf of ['5m', '15m'] as const) {
      feed.load(simCandles.instrument, tf, spec);
      const drawn = rows(h.chart.setData.mock.calls.at(-1)![1]);
      expect(drawn).toEqual(sim[tf].bars.map(toBarTuple));
      const span = timeframeMs(tf);
      for (const bar of drawn as number[][]) {
        const inside = minutes.filter((m) => m[0] >= bar[0]! && m[0] < bar[0]! + span);
        expect(inside[0]?.[0]).toBe(bar[0]);
        expect(bar).toEqual([
          bar[0],
          inside[0]![1],
          Math.max(...inside.map((m) => m[2])),
          Math.min(...inside.map((m) => m[3])),
          inside.at(-1)![4],
          inside.reduce((v, m) => v + m[5], 0),
          inside.reduce((v, m) => v + m[6]!, 0),
        ]);
      }
    }
    expect(onLoading.mock.calls.map((c) => c[0])).toEqual([true, false]);
    feed.dispose();
    h.sources.clear();
  });

  it('clears the old bars and reports loading inside load when the new timeframe is not held, then draws it once', async () => {
    const h = harness({ keepMs: 60_000 });
    const onLoading = vi.fn<(loading: boolean) => void>();
    const onError = vi.fn();
    const feed = new ChartFeed(h.chart, { onLoading, onError, sources: h.sources });
    feed.load('NQ', '1m', spec);
    (await answerOf(h.rt, '1m')).ok(candlesOf('1m'));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));

    feed.load('NQ', '1D', spec);
    expect(h.chart.setData).toHaveBeenCalledTimes(2);
    expect(h.chart.setData).toHaveBeenLastCalledWith('main', []);
    expect(onLoading.mock.calls.map((c) => c[0])).toEqual([true, false, true]);

    const read = await answerOf(h.rt, '1D');
    (await keptOf(h, '1D')).ok(candlesOf('1D', 2));
    await pause();
    expect(h.chart.setData).toHaveBeenCalledTimes(2);
    expect(h.chart.setOptions.mock.calls.some((c) => c[0].timeframeMs === timeframeMs('1D'))).toBe(false);

    read.ok(candlesOf('1D'));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(3));
    const [series, bars, keep] = h.chart.setData.mock.calls[2]!;
    expect(series).toBe('main');
    expect(rows(bars)).toEqual(wireBars('1D'));
    expect(keep).toEqual({ keepView: false });
    expect(h.chart.setOptions).toHaveBeenLastCalledWith(expect.objectContaining({ timeframeMs: timeframeMs('1D') }));
    expect(onLoading.mock.calls.map((c) => c[0])).toEqual([true, false, true, false]);
    expect(onError).not.toHaveBeenCalled();
    feed.dispose();
    h.sources.clear();
  });

  it('loads once across two quick switches, then draws only the one it ended on', async () => {
    const h = harness({ keepMs: 60_000 });
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(h.chart, { onLoading, sources: h.sources });
    feed.load('NQ', '1m', spec);
    (await answerOf(h.rt, '1m')).ok(candlesOf('1m'));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    feed.load('NQ', '5m', spec);
    feed.load('NQ', '15m', spec);
    expect(h.chart.setData).toHaveBeenCalledTimes(2);
    expect(lastLoading(onLoading)).toBe(true);
    (await answerOf(h.rt, '5m')).ok(candlesOf('5m'));
    await pause();
    expect(h.chart.setData).toHaveBeenCalledTimes(2);
    (await answerOf(h.rt, '15m')).ok(candlesOf('15m'));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(3));
    expect(rows(h.chart.setData.mock.calls[2]![1])).toEqual(wireBars('15m'));
    expect(lastLoading(onLoading)).toBe(false);
    feed.dispose();
    h.sources.clear();
  });

  it('clears the chart and reports the error when the new timeframe fails with no bars', async () => {
    const h = harness({ keepMs: 60_000 });
    const onLoading = vi.fn<(loading: boolean) => void>();
    const onError = vi.fn();
    const feed = new ChartFeed(h.chart, { onLoading, onError, sources: h.sources });
    feed.load('NQ', '1m', spec);
    (await answerOf(h.rt, '1m')).ok(candlesOf('1m'));
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    feed.load('NQ', '1D', spec);
    (await answerOf(h.rt, '1D')).fail('not_found', 'no daily bars');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(h.chart.setData).toHaveBeenLastCalledWith('main', []);
    expect(onLoading.mock.calls.at(-1)![0]).toBe(false);
    feed.dispose();
    h.sources.clear();
  });

  it('shows the bars a warm timeframe kept up with while another was shown, and passes its later bars on', async () => {
    const h = harness({ keepMs: 60_000 }, answerEveryTimeframe);
    const feed = new ChartFeed(h.chart, { sources: h.sources, warm: true });
    feed.load('NQ', '1m', spec);
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalledTimes(1));
    await allSettled(h, 'NQ');
    const barEvent = (at: number, close: number): BarUpdate => ({
      instrument: 'NQZ6.CME',
      tf: '5m',
      bar: [ns(T0 + at * timeframeMs('5m')), 1, 9, 0.5, close, 77],
      closed: false,
      source: { provider: 'rithmic-test' },
    });
    const fifth = barEvent(4, 3.5);
    barsTopic(h.rt, '5m').event(fifth);
    expect(h.chart.update).not.toHaveBeenCalled();
    feed.load('NQ', '5m', spec);
    expect(rows(h.chart.setData.mock.calls.at(-1)![1])).toEqual([...wireBars('5m'), toBarTuple(fifth.bar)]);
    const sixth = barEvent(5, 4.5);
    barsTopic(h.rt, '5m').event(sixth);
    expect(h.chart.update).toHaveBeenCalledWith('main', toBarTuple(sixth.bar));
    feed.dispose();
    h.sources.clear();
  });

  it('lets the timeframes no chart draws rest while the window is hidden, and catches them up with only what they missed', async () => {
    const window = new SightSwitch(true);
    const h = harness({ keepMs: 60_000, sight: window }, answerEveryTimeframe);
    const feed = new ChartFeed(h.chart, { sources: h.sources, warm: true });
    feed.load('NQ', '1m', spec);
    await allSettled(h, 'NQ');
    const followed = () =>
      h.rt.subscriptions
        .filter((s) => s.topic === 'market.bars' && s.open)
        .map((s) => (s.params as { tf: Timeframe }).tf)
        .sort();
    expect(followed()).toEqual([...WARM_TIMEFRAMES].sort());
    const readsBefore = snapshots(h.rt).length;

    window.set(false);
    expect(followed()).toEqual(['1m']);

    window.set(true);
    expect(followed()).toEqual([...WARM_TIMEFRAMES].sort());
    const catchUps = snapshots(h.rt).slice(readsBefore);
    expect(catchUps.map((c) => (c.input as { tf: Timeframe }).tf).sort()).toEqual(
      WARM_TIMEFRAMES.filter((tf) => tf !== '1m').sort(),
    );
    for (const c of catchUps) expect((c.input as { limit: number }).limit).toBeLessThanOrEqual(3);
    feed.dispose();
    h.sources.clear();
  });

  it('starts no read of another timeframe until the shown one has settled, and asks the runtime to fill only what is shown', async () => {
    const h = harness({ keepMs: 60_000 });
    const feed = new ChartFeed(h.chart, { sources: h.sources, warm: true });
    feed.load('NQ', '5m', spec);
    const read = await answerOf(h.rt, '5m');
    await pause();
    expect(tfsOf(h.rt, 'market.bars')).toEqual(['5m']);
    expect(tfsOf(h.rt, 'market.history')).toEqual(['5m']);
    read.ok(candlesOf('5m'));
    await vi.waitFor(() => expect(tfsOf(h.rt, 'market.bars').sort()).toEqual([...WARM_TIMEFRAMES].sort()));
    expect(tfsOf(h.rt, 'market.history')).toEqual(['5m']);
    feed.load('NQ', '15m', spec);
    expect(tfsOf(h.rt, 'market.history')).toEqual(['5m', '15m']);
    feed.dispose();
    h.sources.clear();
  });

  it('lets the old symbol’s timeframes go and clears the chart when the symbol changes', async () => {
    const h = harness({ keepMs: 60_000, maxIdle: 50 }, answerEveryTimeframe);
    const onLoading = vi.fn<(loading: boolean) => void>();
    const feed = new ChartFeed(h.chart, { onLoading, sources: h.sources, warm: true });
    feed.load('NQ', '1m', spec);
    await allSettled(h, 'NQ');
    expect(h.sources.size).toBe(WARM_TIMEFRAMES.length);
    expect(h.sources.idle).toBe(0);
    feed.load('ES', '1m', spec);
    expect(h.chart.setData).toHaveBeenLastCalledWith('main', []);
    expect(onLoading.mock.calls.at(-1)![0]).toBe(true);
    expect(h.sources.idle).toBe(WARM_TIMEFRAMES.length);
    await allSettled(h, 'ES');
    feed.dispose();
    expect(h.sources.idle).toBe(h.sources.size);
    h.sources.clear();
  });

  it('warms a print-bar chart’s instrument on every time timeframe', async () => {
    const h = harness({ keepMs: 60_000 });
    const feed = new ChartFeed(h.chart, { sources: h.sources, warm: true });
    feed.load('NQ', '5m', spec, { kind: 'tick', size: 100 });
    const read = await vi.waitFor(() => h.rt.pending('market.get_print_bars'));
    read.ok({
      instrument: 'NQZ6.CME',
      bars: { kind: 'tick', size: 100 },
      priceDecimals: 2,
      columns: ['t', 'o', 'h', 'l', 'c', 'v'],
      candles: [[ns(T0), 1, 2, 0.5, 1.5, 10]],
      lastBarOpen: true,
      gaps: [],
      filling: false,
    });
    await vi.waitFor(() => expect(tfsOf(h.rt, 'market.bars').sort()).toEqual([...WARM_TIMEFRAMES].sort()));
    feed.dispose();
    h.sources.clear();
  });
});

describe('a chart on regular hours', () => {
  const ny = (clock: string) => Date.parse(`2026-10-02T${clock}:00-04:00`);
  const SESSIONS: SessionsOutput = {
    instrument: 'NQZ6.CME',
    hours: {
      calendar: 'cme_equity_index',
      market: 'CME equity index',
      tz: 'America/New_York',
      days: 'Sun–Fri',
      opens: '18:00',
      opensDayBefore: true,
      closes: '17:00',
      rth: { start: '09:30', end: '16:00' },
    },
    sessions: [
      {
        calendar: 'cme_equity_index',
        tradeDate: '2026-10-02',
        open: ns(Date.parse('2026-10-01T18:00:00-04:00')),
        close: ns(ny('17:00')),
        segments: [{ start: ns(Date.parse('2026-10-01T18:00:00-04:00')), end: ns(ny('17:00')) }],
        rth: { start: ns(ny('09:30')), end: ns(ny('16:00')) },
        earlyClose: false,
      },
    ],
    holidays: [],
  };

  const live = (tf: Timeframe, t: number): BarUpdate => ({
    instrument: 'NQZ6.CME',
    tf,
    bar: [ns(t), 20641, 20645, 20640, 20644, 12],
    closed: false,
    source: { provider: 'rithmic-test' },
  });

  async function shown(tf: Timeframe, held: CandlesOutput = output(3)) {
    const h = harness({ keepMs: 0 }, { answers: { 'market.get_sessions': () => SESSIONS } });
    const feed = new ChartFeed(h.chart, { sources: h.sources });
    feed.load('NQ', tf, spec, null, 'rth');
    const bars = await h.bars();
    await vi.waitFor(() => expect(snapshots(h.rt)).toHaveLength(1));
    snapshots(h.rt)[0]!.ok(held);
    await vi.waitFor(() => expect(h.chart.setData).toHaveBeenCalled());
    await vi.waitFor(() => expect(h.rt.toolCalls('market.get_sessions')).toHaveLength(1));
    await pause();
    return { h, feed, bars };
  }

  it('reads the regular-hours bars and draws the live bars that lie wholly inside them', async () => {
    const { h, feed, bars } = await shown('5m');
    expect(snapshots(h.rt)[0]!.input).toEqual({ instrument: 'NQ', tf: '5m', session: 'rth', limit: 1500 });
    bars.event(live('5m', ny('14:45')));
    await vi.waitFor(() => expect(h.chart.update).toHaveBeenCalledTimes(1));
    expect(h.chart.update).toHaveBeenCalledWith('main', toBarTuple(live('5m', ny('14:45')).bar));
    bars.event(live('5m', ny('08:00')));
    bars.event(live('5m', ny('09:25')));
    bars.event(live('5m', ny('16:00')));
    await pause();
    expect(
      h.chart.update,
      'overnight bars and the bars either side of the cash session stay off',
    ).toHaveBeenCalledTimes(1);
    expect(snapshots(h.rt), 'a bar wholly outside is dropped without asking again').toHaveLength(1);
    feed.dispose();
  });

  it('asks the runtime again for a bar that runs across the open, as only its regular-hours part is shown', async () => {
    const yesterday = Date.parse('2026-10-01T13:00:00-04:00');
    const { h, feed, bars } = await shown('1h', {
      ...output(0),
      tf: '1h',
      bars: [0, 1, 2].map((k) => [ns(yesterday + k * 3_600_000), 20600, 20610, 20590, 20605, 900]),
    });
    bars.event(live('1h', ny('09:00')));
    await vi.waitFor(() => expect(snapshots(h.rt)).toHaveLength(2));
    const tail = snapshots(h.rt)[1]!;
    expect(tail.input).toEqual({ instrument: 'NQ', tf: '1h', session: 'rth', limit: 2 });
    expect(h.chart.update, 'the live bar holds overnight prints, so it is not drawn').not.toHaveBeenCalled();
    const rthPart: CandlesOutput['bars'][number] = [ns(ny('09:00')), 20650, 20660, 20645, 20655, 300];
    tail.ok({ ...output(0), tf: '1h', bars: [rthPart] });
    await vi.waitFor(() => expect(h.chart.update).toHaveBeenCalledWith('main', toBarTuple(rthPart)));
    feed.dispose();
  });

  it('keeps regular-hours and all-hours bars of one market apart', async () => {
    const h = harness();
    const a = h.sources.acquire('NQ', '5m', 'all');
    const b = h.sources.acquire('NQ', '5m', 'rth');
    expect(a.source).not.toBe(b.source);
    expect(b.source.session).toBe('rth');
    await vi.waitFor(() => expect(snapshots(h.rt)).toHaveLength(2));
    expect(snapshots(h.rt).map((c) => (c.input as { session?: string }).session)).toEqual([undefined, 'rth']);
    a.release();
    b.release();
  });
});
