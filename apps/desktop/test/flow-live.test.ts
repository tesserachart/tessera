import { createCanvas } from '@napi-rs/canvas';
import {
  createHeadlessChart,
  DeltaLayer,
  DELTA_COLUMNS,
  FootprintLayer,
  PriceFormatter,
  signedCount,
  TESSERA_THEME,
  VolumeProfileLayer,
} from '@tessera/chart';
import type {
  BarUpdate,
  CandlesOutput,
  ChartLayer,
  CompactBar,
  CompactCell,
  CompactFootprint,
  ContractSpec,
  FootprintOutput,
  FootprintUpdate,
  GetCandlesInput,
  GetFootprintInput,
  GetVolumeProfileInput,
  HistoryUpdate,
  ProfileOutput,
  ReachInput,
  VolumeProfileOutput,
} from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartFeed } from '../src/chart/feed.ts';
import { LayerReconciler, type LayerContext } from '../src/chart/layers/index.ts';
import { FlowHub } from '../src/market/flow/hub.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { readsAgain } from './support/readsAgain.ts';
import { seriesSnapshot, seriesSpan } from './support/series.ts';
import { ns } from './support/time.ts';

const counted = (cells: readonly [number, number, number][]): CompactCell[] =>
  cells.map(([price, bid, ask]) => [price, bid, ask, bid + ask > 0 ? 1 : 0]);

const MIN = 60_000;
const ID = 'NQZ6.CME-RITHMIC';
const source = { provider: 'rithmic-apex' };
const OPEN = Date.parse('2026-10-18T18:00:00-04:00');
const RECORDED = Date.parse('2026-10-19T05:22:10-04:00');
const FIRST = (Date.parse('2026-10-19T05:20:00-04:00') - OPEN) / (5 * MIN);
const barT = (k: number) => OPEN + k * 5 * MIN;
const candle = (k: number): CompactBar => {
  const p = 29_700 + (k % 7) * 2;
  return [ns(barT(k)), p, p + 3, p - 3, p + 1, 400 + k];
};
const candles = (from: number, to: number, over: Partial<CandlesOutput> = {}): CandlesOutput => {
  const bars: CompactBar[] = [];
  for (let k = from; k <= to; k++) bars.push(candle(k));
  return {
    instrument: ID,
    tf: '5m',
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v'],
    bars,
    lastBarOpen: true,
    provider: source.provider,
    ...over,
  };
};
const bar = (k: number, cells: [number, number, number][]): CompactFootprint => {
  const ask = cells.reduce((a, c) => a + c[2], 0);
  const bid = cells.reduce((a, c) => a + c[1], 0);
  return {
    t: ns(barT(k)),
    row: 0.25,
    cells: counted(cells),
    poc: null,
    volume: ask + bid,
    delta: ask - bid,
    deltaHigh: Math.max(0, ask - bid),
    deltaLow: Math.min(0, ask - bid),
    aggressorSource: 'exchange',
  };
};
const update = (b: CompactFootprint, over: Partial<FootprintUpdate> = {}): FootprintUpdate => ({
  instrument: ID,
  tf: '5m',
  bar: b,
  closed: false,
  partial: false,
  seq: 1,
  source,
  ...over,
});
const history = (bars: CompactFootprint[], over: Partial<FootprintOutput> = {}): FootprintOutput => ({
  loaded: { sessions: 1, held: 1, refused: false },
  instrument: ID,
  tf: '5m',
  priceDecimals: 2,
  row: 0.25,
  bars,
  truncated: false,
  gaps: [],
  filling: false,
  firstOpen: bars[0]?.t ?? null,
  imbalanceRatio: 3,
  imbalanceMinVolume: 0,
  imbalanceMinDifference: 0,
  imbalanceIncludeZero: false,
  stackedImbalances: [],
  lastBarOpen: bars.length > 0,
  provider: source.provider,
  ...over,
});

const spec = {
  instrument: ID,
  root: 'NQ',
  tickSize: 0.25,
  priceDecimals: 2,
  sessions: 'cme_equity_index',
  tz: 'America/New_York',
} as unknown as ContractSpec;

const layer = (id: string, kind: ChartLayer['kind'], params: ChartLayer['params'] = {}): ChartLayer => ({
  id,
  kind,
  params,
  visible: true,
  namespace: 'user',
  sessionId: null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('order flow on a connection that keeps no trade history', () => {
  it('keeps the footprints up with every update after load, after a prepend, and as bars open', async () => {
    let footprints: FootprintOutput = history([]);
    const rt = fakeRuntime({
      answers: {
        'market.get_candles': (input: GetCandlesInput) =>
          input.cachedOnly && input.to !== undefined
            ? candles(0, FIRST - 61)
            : input.cachedOnly
              ? candles(0, -1)
              : candles(FIRST - 60, FIRST),
        'market.get_footprint': (input: GetFootprintInput) =>
          input.to === undefined ? footprints : history([], { firstOpen: null }),
      },
    });
    const now = { t: RECORDED + 30_000 };
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => now.t,
    });
    const meta = vi.fn();
    const feed = new ChartFeed(chart, { onMeta: meta });
    feed.load(ID, '5m', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));

    const hub = new FlowHub({ now: () => now.t });
    const reconciler = new LayerReconciler();
    const models = [layer('fp', 'footprint')];
    const ctx: LayerContext = {
      chart,
      levels: [],
      levelsSink: { set: () => undefined, remove: () => undefined },
      instrument: ID,
      tf: '5m',
      spec,
      flow: hub,
    };
    reconciler.reconcile(models, ctx);
    const fp = chart.getLayer('model:fp', FootprintLayer)!;
    expect(fp).not.toBeNull();
    chart.setViewport({ barSpacing: 60, lastBars: 4 });
    const detail = (t: number) => {
      chart.render();
      const c = chart.coords();
      const i = chart.getSeries('main')!.indexOfTime(t);
      return fp.askTarget(c.xOfIndex(i), c.yOfPrice(candle(FIRST).at(4)!))?.detail;
    };

    const stream = await vi.waitFor(() => rt.sub('market.footprint'));
    stream.event(update(bar(FIRST, [[29_700, 3, 5]])), 0);
    await vi.waitFor(() => expect(rt.toolCalls('market.get_footprint')).toHaveLength(1));
    const t0 = barT(FIRST);
    await vi.waitFor(() => expect(detail(t0)).toBe('volume 8, delta +2'));

    stream.event(update(bar(FIRST, [[29_700.25, 0, 4]]), { partial: true }));
    stream.event(update(bar(FIRST, [[29_700, 4, 5]]), { partial: true }));
    await vi.waitFor(() => expect(detail(t0)).toBe('volume 13, delta +5'));

    const fill = await vi.waitFor(() => rt.sub('market.history'));
    const kept: HistoryUpdate = { instrument: ID, from: ns(OPEN), to: ns(barT(FIRST)), filling: false };
    fill.event(kept, 0);
    await vi.waitFor(() => expect(chart.getSeries('main')!.length).toBe(FIRST + 1));
    expect(chart.getSeries('main')!.time[0]).toBe(OPEN);
    expect(detail(t0)).toBe('volume 13, delta +5');

    now.t = barT(FIRST + 1) + 5_000;
    const bars = await vi.waitFor(() => rt.sub('market.bars'));
    const next: BarUpdate = { instrument: ID, tf: '5m', bar: candle(FIRST + 1), closed: false, source };
    bars.event(next);
    stream.event(
      update(
        bar(FIRST, [
          [29_700, 4, 5],
          [29_700.25, 0, 4],
        ]),
        { closed: true },
      ),
    );
    stream.event(update(bar(FIRST + 1, [[29_701, 6, 1]])));
    const t1 = barT(FIRST + 1);
    stream.event(update(bar(FIRST + 1, [[29_701.25, 0, 7]]), { partial: true }));

    chart.setViewport({ barSpacing: 60, lastBars: 4 });
    chart.render();
    const c = chart.coords();
    const n = chart.getSeries('main')!.length;
    const at = (i: number) => fp.askTarget(c.xOfIndex(i), c.yOfPrice(candle(i).at(4)!));
    expect(at(n - 1)).toMatchObject({ from: t1, detail: 'volume 14, delta +2' });
    expect(at(n - 2)).toMatchObject({ from: t0, detail: 'volume 13, delta +5' });
    expect(at(n - 3)).toBeNull();

    footprints = history([bar(FIRST + 1, [[29_701, 1, 0]])]);
    stream.resubscribed();
    stream.event(update(bar(FIRST + 1, [[29_701, 1, 0]])), 0);
    const latest = () => rt.toolCalls('market.get_footprint').filter((c) => !('to' in (c.input as object)));
    await vi.waitFor(() => expect(latest()).toHaveLength(2));
    await vi.waitFor(() => expect(detail(t1)).toBe('volume 1, delta −1'));
    stream.event(update(bar(FIRST + 1, [[29_701.25, 0, 3]]), { partial: true }));
    await vi.waitFor(() => expect(detail(t1)).toBe('volume 4, delta +2'));

    reconciler.dispose();
    feed.dispose();
    chart.destroy();
  });

  it('draws a first answer at once, marks no gap while it fills, and lands the filled session in one change', async () => {
    const cells = (k: number): [number, number, number][] => [[29_700 + (k % 3) * 0.25, 1 + (k % 2), 2]];
    const session = Array.from({ length: FIRST + 1 }, (_, k) => bar(k, cells(k)));
    const fromOpen = { firstOpen: ns(OPEN) };
    const answers = [
      history([bar(FIRST, cells(FIRST))], {
        ...fromOpen,
        gaps: [{ from: ns(OPEN), to: ns(barT(FIRST)) }],
        filling: true,
      }),
      history(session.slice(FIRST - 2), {
        ...fromOpen,
        gaps: [{ from: ns(OPEN), to: ns(barT(FIRST - 2)) }],
        filling: true,
      }),
      history(session),
    ];
    const rt = fakeRuntime({
      answers: {
        'market.get_candles': (input: GetCandlesInput) => (input.cachedOnly ? candles(0, -1) : candles(0, FIRST)),
        'market.get_footprint': (input: GetFootprintInput) =>
          input.to === undefined ? (answers.shift() ?? history(session)) : history([], { firstOpen: null }),
      },
    });
    const now = { t: RECORDED + 30_000 };
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => now.t,
    });
    const meta = vi.fn();
    const feed = new ChartFeed(chart, { onMeta: meta });
    feed.load(ID, '5m', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
    const hub = new FlowHub({ now: () => now.t });
    const reconciler = new LayerReconciler();
    const ctx: LayerContext = {
      chart,
      levels: [],
      levelsSink: { set: () => undefined, remove: () => undefined },
      instrument: ID,
      tf: '5m',
      spec,
      flow: hub,
    };
    reconciler.reconcile([layer('fp', 'footprint')], ctx);
    const fp = chart.getLayer('model:fp', FootprintLayer)!;
    const held = hub.acquire(ID, 0.25, 2);
    const footprints = held.flow.useFootprints('5m');
    const lengths: number[] = [];
    footprints.feed.changed.on(() => lengths.push(footprints.feed.store.length));
    const drawnAt = (k: number) => {
      chart.setViewport({ range: { from: barT(Math.max(0, k - 3)), to: barT(k) } });
      chart.render();
      const c = chart.coords();
      const i = chart.getSeries('main')!.indexOfTime(barT(k));
      return fp.askTarget(c.xOfIndex(i), c.yOfPrice(candle(k).at(4)!))?.from;
    };
    const format = new PriceFormatter({ precision: 2, minMove: 0.25 });
    const noteAt = (k: number) => {
      drawnAt(k);
      return { words: fp.legendValues(0, format, TESSERA_THEME).map((v) => v.text), marked: fp.missingPrints() };
    };
    const quiet = { words: [], marked: [] };

    await vi.waitFor(() => expect(rt.toolCalls('market.get_footprint')[0]?.settled).toBe(true));
    await vi.advanceTimersByTimeAsync(10);
    expect(fp.reading()).toBe(false);
    expect(drawnAt(FIRST), 'the bar a filling answer carries is drawn at once').toBe(barT(FIRST));
    expect(drawnAt(0)).toBeUndefined();
    expect(noteAt(3), 'a gap the runtime is filling is neither named nor marked').toEqual(quiet);
    expect(noteAt(FIRST)).toEqual(quiet);

    await readsAgain(1);
    await vi.waitFor(() => expect(rt.toolCalls('market.get_footprint')[1]?.settled).toBe(true));
    await vi.advanceTimersByTimeAsync(10);
    expect(drawnAt(FIRST - 1), 'an answer still filling draws what it holds at once').toBe(barT(FIRST - 1));
    expect(drawnAt(0), 'what the runtime is still filling stays plain').toBeUndefined();
    expect(noteAt(FIRST)).toEqual(quiet);

    await readsAgain(2);
    await vi.waitFor(() => expect(drawnAt(0)).toBe(OPEN));
    expect(drawnAt(FIRST)).toBe(barT(FIRST));
    expect(noteAt(FIRST)).toEqual(quiet);
    expect(
      lengths.find((n) => n > 3),
      'the rest of the filled session lands in one change',
    ).toBe(FIRST + 1);
    const asked = rt.toolCalls('market.get_footprint').length;
    await readsAgain(3);
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(asked);

    footprints.release();
    held.release();
    reconciler.dispose();
    feed.dispose();
    chart.destroy();
  });
});

describe('the CVD pane', () => {
  const TALL = FIRST - 5;
  const cvdRow = (k: number) =>
    k === TALL
      ? { delta: 100, volume: 50, open: 0, high: 110, low: -5, close: 100, candle: 1 }
      : { delta: k % 2 ? 20 : -20, volume: 10, open: 0, high: 25, low: -25, close: k % 2 ? 20 : -20, candle: 1 };
  const columns = (ks: readonly number[], row: (k: number) => ReturnType<typeof cvdRow> = cvdRow) =>
    Object.fromEntries(DELTA_COLUMNS.map((key) => [key, ks.map((k) => row(k)[key])]));
  const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, j) => a + j);

  it('draws the runtime’s delta series as candles on its bars, live, reached back with the chart, with what it knows of the prints', async () => {
    const rt = fakeRuntime({
      answers: {
        'market.get_candles': (input: GetCandlesInput) =>
          input.to === undefined
            ? input.cachedOnly
              ? candles(0, -1)
              : candles(FIRST - 60, FIRST)
            : input.cachedOnly
              ? candles(FIRST - 120, FIRST - 61)
              : candles(0, -1),
        'indicators.reach': (input: ReachInput) => ({ from: input.from }),
      },
    });
    const now = { t: RECORDED + 30_000 };
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => now.t,
    });
    const meta = vi.fn();
    const feed = new ChartFeed(chart, { onMeta: meta });
    feed.load(ID, '5m', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
    const reconciler = new LayerReconciler();
    const ctx: LayerContext = {
      chart,
      levels: [],
      levelsSink: { set: () => undefined, remove: () => undefined },
      instrument: ID,
      tf: '5m',
      spec,
      flow: new FlowHub({ now: () => now.t }),
    };
    reconciler.reconcile([layer('cvd', 'delta')], ctx);
    const cvd = chart.getLayer('model:cvd', DeltaLayer)!;
    const series = await vi.waitFor(() => rt.sub('indicators.series'));
    expect(series.params).toEqual({
      indicator: 'delta',
      inputs: { reset: 'session', daysToLoad: 2 },
      instrument: ID,
      tf: '5m',
      from: ns(barT(FIRST - 60)),
    });

    const shown = span(FIRST - 60, FIRST);
    const over = { indicator: 'delta', instrument: ID, aggressorSource: 'exchange' as const };
    const unknownNewest = columns(shown, (k) => (k === FIRST ? { ...cvdRow(k), delta: NaN, close: NaN } : cvdRow(k)));
    series.event(seriesSnapshot(1, shown.map(barT), unknownNewest, over));
    expect(cvd.reading()).toBe(false);
    series.event(seriesSnapshot(2, shown.map(barT), columns(shown), over));
    const format = new PriceFormatter({ precision: 2, minMove: 0.25 });
    const legend = (t: number) =>
      cvd.legendValues(chart.getSeries('main')!.indexOfTime(t), format, TESSERA_THEME).map((v) => v.text);
    const legendAt = (t: number) => legend(t)[0];
    expect(legendAt(barT(FIRST))).toBe(signedCount(cvdRow(FIRST).close));

    chart.setViewport({ barSpacing: 24, lastBars: 20 });
    chart.render(true);
    const scale = (chart.engine as unknown as { paneScales: Map<string, { yOf(v: number): number }> }).paneScales.get(
      cvd.pane,
    )!;
    const main = chart.canvases.main.getContext('2d') as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    const ink = (k: number, v: number) => {
      const x = chart.coords().xOfIndex(chart.getSeries('main')!.indexOfTime(barT(k)));
      return [...main.getImageData(Math.round(x), Math.round(scale.yOf(v)), 1, 1).data.slice(0, 3)];
    };
    const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const [lowest, highest] = cvd.autoscaleRange(chart.coords().from, chart.coords().to)!;
    expect(scale.yOf(lowest) - scale.yOf(highest), 'the visible CVD fills its pane under the legend').toBeGreaterThan(
      100,
    );
    expect(ink(TALL, 50)).toEqual(hex(chart.theme.flow.deltaUp));
    expect(ink(FIRST - 2, -10)).toEqual(hex(chart.theme.flow.deltaDown));

    const settled = over;
    const t0 = barT(FIRST);
    series.event(
      seriesSpan(
        3,
        [t0, t0],
        [t0],
        columns([FIRST], (k) => ({ ...cvdRow(k), close: 999 })),
        settled,
      ),
    );
    expect(legendAt(t0)).toBe('+999');

    expect(rt.toolCalls('indicators.reach')).toHaveLength(0);
    const fill = rt.sub('market.history');
    fill.event({ instrument: ID, from: ns(barT(FIRST - 120)), to: ns(t0), filling: false } satisfies HistoryUpdate, 0);
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(1));
    expect(rt.toolCalls('indicators.reach')[0]!.input).toEqual({
      instrument: ID,
      tf: '5m',
      from: ns(barT(FIRST - 120)),
    });
    const older = span(FIRST - 120, FIRST - 61);
    expect(legend(barT(FIRST - 120)), 'no value and no words where the CVD has no prints').toEqual([]);
    series.event(seriesSpan(4, [barT(FIRST - 120), barT(FIRST - 61)], older.map(barT), columns(older), settled));
    expect(legend(barT(FIRST - 120))).toEqual([signedCount(cvdRow(FIRST - 120).close)]);
    expect(legendAt(t0)).toBe('+999');

    reconciler.reconcile([layer('cvd', 'delta', { inputs: { reset: 'chart' } })], ctx);
    const chartWide = await vi.waitFor(() => {
      const s = rt.sub('indicators.series');
      if (s === series) throw new Error('not subscribed for the chart yet');
      return s;
    });
    expect(chartWide.params).toMatchObject({ inputs: { reset: 'chart' }, from: ns(barT(FIRST - 120)) });
    expect(series.open, 'the session CVD stays warm a while').toBe(true);
    reconciler.dispose();
    vi.advanceTimersByTime(5 * 60_000);
    expect(rt.subscriptions.filter((s) => s.topic === 'indicators.series' && s.open)).toEqual([]);
    feed.dispose();
    chart.destroy();
  });
  it('tables in the footprint the same CVD series a CVD pane draws, read while the table shows', async () => {
    const rt = fakeRuntime({
      answers: {
        'market.get_candles': (input: GetCandlesInput) =>
          input.to === undefined && !input.cachedOnly ? candles(FIRST - 60, FIRST) : candles(0, -1),
        'market.get_footprint': () => history([]),
      },
    });
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => RECORDED,
    });
    const meta = vi.fn();
    const feed = new ChartFeed(chart, { onMeta: meta });
    feed.load(ID, '5m', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
    const reconciler = new LayerReconciler();
    const ctx: LayerContext = {
      chart,
      levels: [],
      levelsSink: { set: () => undefined, remove: () => undefined },
      instrument: ID,
      tf: '5m',
      spec,
      flow: new FlowHub({ now: () => RECORDED }),
    };
    const open = () => rt.subscriptions.filter((s) => s.topic === 'indicators.series' && s.open);
    const table = layer('fp', 'footprint', { inputs: { stats: true } });
    reconciler.reconcile([table, layer('cvd', 'delta')], ctx);
    await vi.waitFor(() => expect(open()).toHaveLength(1));
    expect(open()[0]!.params).toMatchObject({ indicator: 'delta', inputs: { reset: 'session' } });
    reconciler.reconcile([layer('fp', 'footprint', { inputs: { stats: false } }), layer('cvd', 'delta')], ctx);
    expect(open()).toHaveLength(1);
    reconciler.reconcile([layer('fp', 'footprint', { inputs: { stats: false } })], ctx);
    expect(open(), 'a CVD no chart shows stays warm a while').toHaveLength(1);
    reconciler.reconcile([table], ctx);
    expect(rt.subscriptions.filter((s) => s.topic === 'indicators.series')).toHaveLength(1);
    reconciler.dispose();
    vi.advanceTimersByTime(5 * 60_000);
    expect(open()).toHaveLength(0);
    feed.dispose();
    chart.destroy();
  });
});

describe('order flow read back as the chart scrolls', () => {
  const opens = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-04', '2026-10-05'].map(
    (d) => Date.parse(`${d}T18:00:00-04:00`),
  );
  const SESSION = 23 * 60 * MIN;
  const NOW = Date.parse('2026-10-06T10:00:00-04:00');
  const times: number[] = [];
  const sessionOf: number[] = [];
  opens.forEach((open, s) => {
    for (let t = open; t < Math.min(open + SESSION, NOW); t += MIN) {
      times.push(t);
      sessionOf.push(s);
    }
  });
  const n = times.length;
  const upTo = (toNs: number) => {
    let k = 0;
    while (k < n && ns(times[k]!) <= toNs) k++;
    return k;
  };
  const bid = (k: number) => 1 + (k % 5);
  const ask = (k: number) => 1 + ((k * 7) % 6);
  const price = (k: number) => 29_700 + (k % 4) * 0.25;
  const footprintsFor = (input: GetFootprintInput): FootprintOutput => {
    const hi = input.to === undefined ? n : upTo(input.to);
    const lo = input.from === undefined ? 0 : times.findIndex((t) => ns(t) >= Number(input.from));
    const k0 = Math.max(lo, hi - (input.limit ?? 20));
    const bars = times.slice(k0, hi).map((t, j): CompactFootprint => ({
      t: ns(t),
      row: 0.25,
      cells: [[price(k0 + j), bid(k0 + j), ask(k0 + j), 1]],
      poc: null,
      volume: bid(k0 + j) + ask(k0 + j),
      delta: ask(k0 + j) - bid(k0 + j),
      deltaHigh: Math.max(0, ask(k0 + j) - bid(k0 + j)),
      deltaLow: Math.min(0, ask(k0 + j) - bid(k0 + j)),
      aggressorSource: 'exchange',
    }));
    return { ...history(bars), tf: '1m', lastBarOpen: input.to === undefined };
  };
  const profilesFor = (input: GetVolumeProfileInput, sessionRead: boolean): VolumeProfileOutput => {
    const last = input.to === undefined ? opens.length - 1 : (sessionOf[upTo(input.to) - 1] ?? -1);
    const first = Math.max(0, last - (input.sessions ?? 1) + 1);
    const profile = (open: number): ProfileOutput => ({
      from: ns(open),
      to: ns(Math.min(open + SESSION, NOW)),
      sessionEnd: ns(open + SESSION),
      tradeDate: null,
      row: 0.25,
      poc: null,
      vah: null,
      val: null,
      valueAreaVolume: 0,
      volume: sessionRead ? 0 : 100,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      high: null,
      low: null,
      prints: 0,
      firstPrint: null,
      lastPrint: null,
      gaps: sessionRead ? [{ from: ns(open), to: ns(Math.min(open + SESSION, NOW)) }] : [],
      rows: sessionRead ? [] : [[29_700, 100, 60, 40]],
    });
    return {
      loaded: { sessions: 1, held: 1, refused: false },
      instrument: ID,
      priceDecimals: 2,
      mode: 'session',
      period: 'session',
      valueAreaPercent: 70,
      columns: [],
      profiles: opens.slice(first, last + 1).map(profile),
      filling: sessionRead,
      aggressorSource: 'exchange',
      provider: source.provider,
    };
  };

  async function scrolledBack(models: ChartLayer[]) {
    let sessionRead = true;
    const rt = fakeRuntime({
      answers: {
        'market.get_footprint': (input: GetFootprintInput) => footprintsFor(input),
        'market.get_volume_profile': (input: GetVolumeProfileInput) => {
          const out = profilesFor(input, sessionRead);
          sessionRead = false;
          return out;
        },
        'market.get_candles': (input: GetCandlesInput) => {
          const hi = input.cachedOnly ? (input.to === undefined ? 0 : upTo(input.to)) : n;
          const lo = Math.max(0, hi - (input.cachedOnly ? (input.limit ?? hi) : 200));
          return {
            ...candles(0, -1),
            tf: '1m',
            bars: times
              .slice(lo, hi)
              .map((t, j): CompactBar => [ns(t), price(lo + j), price(lo + j), price(lo + j), price(lo + j), 10]),
          };
        },
      },
    });
    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => NOW,
    });
    const meta = vi.fn();
    const feed = new ChartFeed(chart, { onMeta: meta });
    feed.load(ID, '1m', spec);
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(1));
    const fill = await vi.waitFor(() => rt.sub('market.history'));
    fill.event({ instrument: ID, from: ns(opens[0]!), to: ns(times[n - 1]!), filling: false }, 0);
    await vi.waitFor(() => expect(chart.getSeries('main')!.length).toBe(n));
    const reconciler = new LayerReconciler();
    reconciler.reconcile(models, {
      chart,
      levels: [],
      levelsSink: { set: () => undefined, remove: () => undefined },
      instrument: ID,
      tf: '1m',
      spec,
      flow: new FlowHub({ now: () => NOW }),
    });
    return {
      rt,
      chart,
      scrollTo: (from: number) => {
        chart.setViewport({ range: { from, to: from + 60 * MIN } });
        chart.render();
      },
      dispose: () => {
        reconciler.dispose();
        feed.dispose();
        chart.destroy();
      },
    };
  }

  it('draws the session profiles of sessions scrolled back to, read again once the runtime has read the session back', async () => {
    const desk = await scrolledBack([layer('vp', 'volume_profile', { inputs: { period: 'session' } })]);
    const { chart } = desk;
    const vp = chart.getLayer('model:vp', VolumeProfileLayer)!;
    const drawnFrom = () => {
      chart.render();
      const y = chart.coords().yOfPrice(29_700);
      return new Set(Array.from({ length: 600 }, (_, x) => vp.askTarget(x * 2, y)?.from));
    };
    await readsAgain(1);
    await vi.waitFor(() => expect(drawnFrom()).toContain(opens[6]));

    desk.scrollTo(opens[0]!);
    await vi.waitFor(() => expect(drawnFrom()).toContain(opens[0]));
    desk.scrollTo(opens[3]!);
    await vi.waitFor(() => expect(drawnFrom()).toContain(opens[3]));
    const reads = desk.rt.toolCalls('market.get_volume_profile').length;
    await readsAgain(2);
    expect(desk.rt.toolCalls('market.get_volume_profile')).toHaveLength(reads);
    desk.dispose();
  });
});

describe('the volume profile while the runtime reads its session back', () => {
  it('draws no histogram for the session until its backfill completes, then all of it in one change, with its POC', async () => {
    const T = Date.parse('2026-10-19T10:00:00-04:00');
    const HOUR = 60 * MIN;
    const ES = 'ESZ6.CME';
    const sessionOut = (
      from: number,
      to: number,
      rows: [number, number, number, number][],
      knownFrom: number | null,
    ): ProfileOutput => ({
      from: ns(from),
      to: ns(Math.min(to, T)),
      sessionEnd: ns(to),
      tradeDate: null,
      row: 0.25,
      poc: null,
      vah: null,
      val: null,
      valueAreaVolume: 0,
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      delta: 0,
      high: null,
      low: null,
      prints: 0,
      firstPrint: null,
      lastPrint: null,
      gaps: knownFrom === null ? [] : [{ from: ns(from), to: ns(knownFrom) }],
      rows,
    });
    const answer = (profiles: ProfileOutput[], filling: boolean): VolumeProfileOutput => ({
      loaded: { sessions: 1, held: 1, refused: false },
      instrument: ES,
      priceDecimals: 2,
      mode: 'session',
      period: 'session',
      valueAreaPercent: 70,
      columns: [],
      profiles,
      filling,
      aggressorSource: 'exchange',
      provider: source.provider,
    });
    const older = sessionOut(T - 3 * HOUR, T - HOUR, [[5800.75, 40, 20, 20]], null);
    const rows: [number, number, number, number][] = [
      [5800, 10, 6, 4],
      [5800.25, 30, 20, 10],
      [5800.5, 5, 1, 4],
    ];
    const today = (n: number, knownFrom: number | null) =>
      sessionOut(T - HOUR, T + HOUR, rows.slice(rows.length - n), knownFrom);
    const answers = [
      answer([older, today(1, T - 10 * MIN)], true),
      answer([today(2, T - 30 * MIN)], true),
      answer([today(3, null)], false),
    ];
    const rt = fakeRuntime({
      answers: { 'market.get_volume_profile': () => answers.shift() ?? answer([older], false) },
    });

    const chart = createHeadlessChart({
      width: 1200,
      height: 700,
      createCanvas: (w, h) => createCanvas(w, h),
      now: () => T,
      timeframeMs: MIN,
      priceFormat: { precision: 2, minMove: 0.25 },
    });
    chart.setData(
      'main',
      Array.from({ length: 180 }, (_, k) => {
        const p = 5800 + (k % 3) * 0.25;
        return { t: T - 3 * HOUR + k * MIN, o: p, h: p + 0.75, l: p - 0.5, c: p + 0.25, v: 10 };
      }),
    );
    chart.setLayerVisible('grid', false);
    chart.setViewport({ range: { from: T - 3 * HOUR, to: T - MIN } });
    const hub = new FlowHub({ now: () => T });
    const { flow, release } = hub.acquire(ES, 0.25, 2);
    const line = (color: string) => ({ color, width: 1, line: 'solid' as const, opacity: 1, visible: true });
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: flow.grid,
      options: { period: 'session', rowTicks: 1, nakedPocs: false },
      style: { poc: line('#dcebef'), vah: line('#6f7c82'), val: line('#6f7c82') },
    });
    chart.addLayer(vp);
    const format = new PriceFormatter({ precision: 2, minMove: 0.25 });
    const painted = () => {
      chart.render(true);
      const c = chart.coords();
      const series = chart.getSeries('main')!;
      const split = (c.xOfIndex(series.indexOfTime(T - HOUR) - 1) + c.xOfIndex(series.indexOfTime(T - HOUR))) / 2;
      const canvas = chart.canvases.underlay as unknown as ReturnType<typeof createCanvas>;
      const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let before = 0;
      let after = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          if (px[(y * canvas.width + x) * 4 + 3] === 0) continue;
          if (x < split) before++;
          else after++;
        }
      const poc = vp.legendValues(0, format, TESSERA_THEME).find((v) => v.text.startsWith('POC'))?.text ?? null;
      return { older: before, today: after, poc };
    };
    const blank = painted();

    const profiles = flow.useProfiles();

    profiles.feed.periods('session');
    vp.setSource(profiles.feed);
    const seen: { reads: number; older: number; today: number; poc: string | null }[] = [];
    profiles.feed.changed.on(() =>
      seen.push({ reads: rt.toolCalls('market.get_volume_profile').length, ...painted() }),
    );
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(1));
    await readsAgain(1);
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(2));
    await readsAgain(2);
    await vi.waitFor(() => expect(painted().today).toBeGreaterThan(blank.today));

    const reading = seen.filter((x) => x.reads < 3);
    const firstDrawn = reading.find((x) => x.reads === 1)!;
    expect(
      reading.filter((x) => x.reads === 2).every((x) => x.older === firstDrawn.older && x.today === firstDrawn.today),
      'the first answer is drawn and an answer still filling is not',
    ).toBe(true);
    expect(
      reading.some((x) => x.older > blank.older),
      'the whole older session is drawn from the first answer',
    ).toBe(true);
    expect(
      reading.map((x) => x.today),
      'nothing of the session being read is drawn',
    ).toEqual(reading.map(() => blank.today));
    expect(
      reading.map((x) => x.poc),
      'and the legend shows no POC for it',
    ).toEqual(reading.map(() => null));
    const drawn = seen.filter((x) => x.today > blank.today);
    expect(new Set(drawn.map((x) => x.today)).size, 'the session lands whole, never growing').toBe(1);
    expect(drawn[0]!.reads).toBe(3);
    expect(painted().poc).toBe(`POC ${format.grouped(5800.25)}`);

    profiles.release();
    release();
    chart.destroy();
  });
});
