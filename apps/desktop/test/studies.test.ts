import type { SeriesChange } from '@tessera/chart';
import type {
  CandlesOutput,
  GetCandlesInput,
  IndicatorObjects,
  PrintBars,
  PrintBarsOutput,
  ReachInput,
  SeriesParams,
} from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BarSources } from '../src/market/bars.ts';
import { printBarSources } from '../src/market/printBars.ts';
import {
  StudyLink,
  StudySources,
  studyAsk,
  type StudyAsk,
  type StudySource,
  type StudyView,
} from '../src/market/studies.ts';
import { fakeRuntime, type FakeRuntime, type FakeSubscription } from './support/fakeRuntime.ts';
import { seriesSnapshot, seriesSpan } from './support/series.ts';
import { pause } from './support/pause.ts';
import { ns } from './support/time.ts';
import { manualTimers } from './support/timers.ts';

const T0 = Date.parse('2026-10-19T09:30:00-04:00');
const MIN5 = 300_000;
const at = (k: number) => T0 + k * MIN5;
function candles(from: number, to: number): CandlesOutput {
  const bars: CandlesOutput['bars'] = [];
  for (let k = from; k <= to; k++) bars.push([ns(at(k)), 100, 101, 99, 100.5, 10]);
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

const snapshot = { from: 0 };

function page(input: GetCandlesInput): CandlesOutput {
  if (input.to === undefined) return input.cachedOnly ? candles(0, -1) : candles(snapshot.from, 9);
  const last = Math.floor((input.to / 1e6 - T0) / MIN5);
  return candles(last - 9, last);
}

const EMA: StudyAsk = { instrument: 'QQQ', tf: '5m', indicator: 'ema', inputs: { length: 9, source: 'close' } };

function desk() {
  snapshot.from = 0;
  const rt = fakeRuntime({
    answers: {
      'market.get_candles': page,
      'indicators.reach': (input: ReachInput) => ({ from: input.from }),
    },
  });
  const bars = new BarSources({ keepMs: 0 });
  return { rt, bars, studies: new StudySources({ bars }) };
}

const seriesSubs = (rt: FakeRuntime) => rt.subscriptions.filter((s) => s.topic === 'indicators.series');
const openSeries = (rt: FakeRuntime) => seriesSubs(rt).filter((s) => s.open);

function held(source: StudySource, key = 'ma'): [number, number][] {
  const col = source.values.column(key);
  return [...source.values.time].map((t, i) => [t, col ? col[i]! : Number.NaN]);
}

async function resubscribed(rt: FakeRuntime, old: FakeSubscription): Promise<FakeSubscription> {
  return vi.waitFor(() => {
    const s = rt.sub('indicators.series');
    if (s === old) throw new Error('not subscribed again yet');
    return s;
  });
}

describe('a study source', () => {
  it('subscribes at once without waiting for the chart’s bars, and from their first bar once the chart has them', async () => {
    const rt = fakeRuntime();
    const bars = new BarSources({ keepMs: 0 });
    const studies = new StudySources({ bars });
    const ema = studies.acquire(EMA);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    expect(sub.params).toEqual({
      indicator: 'ema',
      inputs: { length: 9, source: 'close' },
      instrument: 'QQQ',
      tf: '5m',
    } satisfies SeriesParams);
    const read = await vi.waitFor(() => {
      const read = rt.pending('market.get_candles');
      expect((read.input as GetCandlesInput).cachedOnly).toBeUndefined();
      return read;
    });
    expect(read.settled).toBe(false);
    read.ok(candles(0, 9));
    const chart = bars.acquire('QQQ', '5m');
    await vi.waitFor(() => expect(chart.source.series.time[0]).toBe(at(0)));
    const rsi = studies.acquire({ ...EMA, indicator: 'rsi', inputs: { length: 14 } });
    const second = await vi.waitFor(() => {
      const s = openSeries(rt).find((s) => (s.params as SeriesParams).indicator === 'rsi');
      if (!s) throw new Error('rsi not subscribed yet');
      return s;
    });
    expect(second.params).toMatchObject({ from: ns(at(0)) });
    expect(rt.toolCalls('indicators.reach')).toHaveLength(0);
    for (const s of [ema, rsi, chart]) s.release();
  });

  it('is measured over the regular-hours bars of a chart on regular hours: its series, its bars and its reach', async () => {
    const study = { indicator: 'vwap', inputs: {} };
    expect(studyAsk({ instrument: 'QQQ', tf: '5m', session: 'all' }, study)).not.toHaveProperty('session');
    expect(
      studyAsk({ instrument: 'QQQ', tf: '5m', printBars: { kind: 'tick', size: 500 }, session: 'rth' }, study),
      'print bars are built from every print',
    ).not.toHaveProperty('session');
    const ask = studyAsk({ instrument: 'QQQ', tf: '5m', session: 'rth' }, study)!;
    expect(ask.session).toBe('rth');
    const rt = fakeRuntime({ answers: { 'indicators.reach': (input: ReachInput) => ({ from: input.from }) } });
    const studies = new StudySources({ bars: new BarSources({ keepMs: 0 }) });
    const all = studies.acquire({ ...ask, session: undefined });
    const rth = studies.acquire(ask);
    expect(rth.source, 'a regular-hours study is its own series').not.toBe(all.source);
    const sub = await vi.waitFor(() => {
      const s = openSeries(rt).find((x) => (x.params as SeriesParams).session === 'rth');
      if (!s) throw new Error('not subscribed yet');
      return s;
    });
    expect(sub.params).toMatchObject({ indicator: 'vwap', instrument: 'QQQ', tf: '5m', session: 'rth' });
    sub.event(seriesSnapshot(1, [5, 6, 7, 8, 9].map(at), { vwap: [5, 6, 7, 8, 9] }));
    const read = await vi.waitFor(() => {
      const r = rt
        .toolCalls('market.get_candles')
        .find(
          (c) =>
            !c.settled && (c.input as GetCandlesInput).session === 'rth' && !(c.input as GetCandlesInput).cachedOnly,
        );
      if (!r) throw new Error('no regular-hours read yet');
      return r;
    });
    read.ok(candles(0, 9));
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(1));
    expect(rt.toolCalls('indicators.reach')[0]!.input).toEqual({
      instrument: 'QQQ',
      tf: '5m',
      from: ns(at(0)),
      session: 'rth',
    });
    all.release();
    rth.release();
  });

  it('reaches back to the chart’s first bar when a reset reads earlier than the snapshot holds, and takes those rows from the span', async () => {
    const rt = fakeRuntime({ answers: { 'indicators.reach': (input: ReachInput) => ({ from: input.from }) } });
    const studies = new StudySources({ bars: new BarSources({ keepMs: 0 }) });
    const { source, release } = studies.acquire(EMA);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    sub.event(seriesSnapshot(1, [5, 6, 7, 8, 9].map(at), { ma: [5, 6, 7, 8, 9] }));
    await pause();
    expect(rt.toolCalls('indicators.reach')).toHaveLength(0);
    const read = await vi.waitFor(() => {
      const read = rt.pending('market.get_candles');
      expect((read.input as GetCandlesInput).cachedOnly).toBeUndefined();
      return read;
    });
    read.ok(candles(0, 9));
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(1));
    expect(rt.toolCalls('indicators.reach')[0]!.input).toEqual({ instrument: 'QQQ', tf: '5m', from: ns(at(0)) });
    sub.event(seriesSpan(2, [at(0), at(4)], [0, 1, 2, 3, 4].map(at), { ma: [0, 1, 2, 3, 4] }));
    expect(held(source)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => [at(k), k]));
    await pause();
    expect(rt.toolCalls('indicators.reach')).toHaveLength(1);
    release();
  });

  it('is reading until its first update, empty or not, and not once it is refused', async () => {
    const rt = fakeRuntime();
    const studies = new StudySources({ bars: new BarSources({ keepMs: 0 }) });
    const first = studies.acquire(EMA);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    expect(first.source.reading).toBe(true);
    sub.event(seriesSnapshot(1, [], {}));
    expect(first.source.reading).toBe(false);
    const second = studies.acquire({ ...EMA, inputs: { ...EMA.inputs, length: 21 } });
    const other = await vi.waitFor(() => openSeries(rt).find((s) => s !== sub)!);
    expect(second.source.reading).toBe(true);
    other.refuse('connecting to Rithmic');
    expect(second.source.reading).toBe(false);
    first.release();
    second.release();
  });

  it('reaches every study of a chart back once per page or reset that reaches earlier, and not for bars it reaches', async () => {
    const { rt, bars, studies } = desk();
    const ema = studies.acquire(EMA);
    const rsi = studies.acquire({ ...EMA, indicator: 'rsi', inputs: { length: 14 } });
    await vi.waitFor(() => expect(openSeries(rt)).toHaveLength(2));
    const chart = bars.acquire('QQQ', '5m');
    await vi.waitFor(() => expect(chart.source.series.time[0]).toBe(at(0)));
    const from = (k: number) => Array.from({ length: 10 - k }, (_, i) => at(k + i));
    for (const s of openSeries(rt)) s.event(seriesSnapshot(1, from(0), { ma: from(0) }));
    await pause();
    expect(rt.toolCalls('indicators.reach')).toHaveLength(0);
    chart.source.pageOlder();
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(1));
    expect(rt.toolCalls('indicators.reach')[0]!.input).toEqual({ instrument: 'QQQ', tf: '5m', from: ns(at(-10)) });
    chart.source.reload();
    await pause();
    expect(chart.source.series.time[0]).toBe(at(-10));
    expect(rt.toolCalls('indicators.reach')).toHaveLength(1);
    chart.source.pageOlder();
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(2));
    expect(rt.toolCalls('indicators.reach')[1]!.input).toMatchObject({ from: ns(at(-20)) });
    snapshot.from = -30;
    chart.source.reload();
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(3));
    expect(rt.toolCalls('indicators.reach')[2]!.input).toMatchObject({ from: ns(at(-30)) });
    const later = studies.acquire({ ...EMA, inputs: { length: 21 } });
    await vi.waitFor(() => expect(openSeries(rt)).toHaveLength(3));
    expect(openSeries(rt)[2]!.params).toMatchObject({ from: ns(at(-30)) });
    openSeries(rt)[2]!.event(seriesSnapshot(1, from(-30), { ma: from(-30) }));
    await pause();
    expect(rt.toolCalls('indicators.reach')).toHaveLength(3);
    const short = studies.acquire({ ...EMA, inputs: { length: 50 } });
    await vi.waitFor(() => expect(openSeries(rt)).toHaveLength(4));
    openSeries(rt)[3]!.event(seriesSnapshot(1, from(-25), { ma: from(-25) }));
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(4));
    expect(rt.toolCalls('indicators.reach')[3]!.input).toMatchObject({ from: ns(at(-30)) });
    for (const s of [ema, rsi, later, short, chart]) s.release();
  });

  it('applies updates in order, drops what it already holds and subscribes again when one is missed', async () => {
    const { rt, bars, studies } = desk();
    const { source, release } = studies.acquire(EMA);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    const chart = bars.acquire('QQQ', '5m');
    await vi.waitFor(() => expect(chart.source.series.time[0]).toBe(at(0)));
    const changes: SeriesChange[] = [];
    source.changed.on((c) => changes.push(c));
    sub.event(seriesSpan(3, [at(9), at(9)], [at(9)], { ma: [99] }));
    expect(source.values.length).toBe(0);
    sub.event(seriesSnapshot(4, [at(8), at(9)], { ma: [8, 9] }));
    sub.event(seriesSpan(4, [at(9), at(9)], [at(9)], { ma: [90] }));
    sub.event(seriesSpan(5, [at(9), at(9)], [at(9)], { ma: [9.5] }));
    sub.event(seriesSnapshot(5, [at(9)], { ma: [0] }));
    expect(held(source)).toEqual([
      [at(8), 8],
      [at(9), 9.5],
    ]);
    expect(changes).toEqual([{ kind: 'all' }, { kind: 'span', from: at(9), to: at(9) }]);

    sub.event(seriesSpan(7, [at(9), at(9)], [at(9)], { ma: [70] }));
    expect(sub.open).toBe(false);
    expect(held(source)).toEqual([
      [at(8), 8],
      [at(9), 9.5],
    ]);
    const again = await resubscribed(rt, sub);
    expect(again.params).toMatchObject({ from: ns(at(0)) });
    again.event(seriesSnapshot(2, [at(9)], { ma: [7] }));
    expect(held(source)).toEqual([[at(9), 7]]);

    again.gap();
    const third = await resubscribed(rt, again);
    third.event(seriesSnapshot(6, [at(9)], { ma: [6] }));
    third.resubscribed();
    await pause();
    expect(openSeries(rt), 'the series the runtime resubscribed on a reconnect is kept').toEqual([third]);
    third.event(seriesSnapshot(1, [at(9)], { ma: [1] }));
    expect(held(source)).toEqual([[at(9), 1]]);
    release();
    chart.release();
  });

  it('keeps the rows a chart reached back for when a reconnect resubscribes, until the runtime serves them again', async () => {
    const { rt, bars, studies } = desk();
    const { source, release } = studies.acquire(EMA);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    const chart = bars.acquire('QQQ', '5m');
    await vi.waitFor(() => expect(chart.source.series.time[0]).toBe(at(0)));
    const ks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    sub.event(seriesSnapshot(1, ks(5, 9).map(at), { ma: ks(5, 9) }));
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(1));
    sub.event(seriesSpan(2, [at(0), at(4)], ks(0, 4).map(at), { ma: ks(0, 4) }));
    const changes: SeriesChange[] = [];
    source.changed.on((c) => changes.push(c));

    sub.resubscribed();
    sub.event(seriesSnapshot(1, ks(5, 9).map(at), { ma: ks(5, 9).map((k) => k * 10) }));
    expect(held(source)).toEqual([...ks(0, 4).map((k) => [at(k), k]), ...ks(5, 9).map((k) => [at(k), k * 10])]);
    await vi.waitFor(() => expect(rt.toolCalls('indicators.reach')).toHaveLength(2));
    expect(rt.toolCalls('indicators.reach')[1]!.input).toMatchObject({ from: ns(at(0)) });
    sub.event(seriesSpan(2, [at(0), at(4)], ks(0, 4).map(at), { ma: ks(0, 4).map((k) => k * 10) }));
    expect(held(source)).toEqual(ks(0, 9).map((k) => [at(k), k * 10]));
    expect(changes).toEqual([{ kind: 'all' }, { kind: 'span', from: at(0), to: at(4) }]);
    expect(seriesSubs(rt)).toHaveLength(1);
    release();
    chart.release();
  });

  it('is one subscription for asks that are the same, kept warm a while after the last of them lets go', async () => {
    const timers = manualTimers();
    const rt = fakeRuntime();
    const bars = new BarSources({ keepMs: 0 });
    const studies = new StudySources({ bars, keepMs: 60_000, maxIdle: 1, timers });
    const a = studies.acquire(EMA);
    const b = studies.acquire({
      indicator: 'ema',
      inputs: { source: 'close', length: 9 },
      tf: '5m',
      instrument: 'QQQ',
    });
    expect(b.source).toBe(a.source);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    a.release();
    b.release();
    expect(sub.open, 'a study let go stays warm').toBe(true);
    expect(studies.idle).toBe(1);
    const again = studies.acquire(EMA);
    expect(again.source).toBe(a.source);
    expect(studies.idle).toBe(0);
    again.release();
    timers.run(59_000);
    expect(sub.open).toBe(true);
    const rsi = studies.acquire({ ...EMA, indicator: 'rsi', inputs: { length: 14 } });
    rsi.release();
    expect(sub.open, 'past the studies kept warm the oldest goes').toBe(false);
    expect(studies.size).toBe(1);
    timers.run(60_000);
    expect(studies.size).toBe(0);
    expect(bars.size).toBe(0);
    await vi.waitFor(() => expect(openSeries(rt)).toHaveLength(0));
    expect(seriesSubs(rt).filter((s) => (s.params as SeriesParams).indicator === 'ema')).toHaveLength(1);
  });

  it('is one computation for CVD on NQ 1m across a tab switch, a reconnect and a second chart, and never blanks', async () => {
    const rt = fakeRuntime();
    const studies = new StudySources({ bars: new BarSources({ keepMs: 0 }) });
    const cvd = studyAsk({ instrument: 'NQ', tf: '1m' }, { indicator: 'delta', inputs: { reset: 'session' } })!;
    const minute = (k: number) => T0 + k * 60_000;
    const drawn: number[] = [];
    const view: StudyView = {
      linked: (source) => {
        if (source) drawn.push(source.values.length);
      },
      changed: (source) => drawn.push(source.values.length),
    };
    const chart = new StudyLink(view, () => studies);
    chart.follow(cvd);
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    sub.event(seriesSnapshot(1, [0, 1, 2].map(minute), { delta: [3, -1, 2], cvd: [3, 2, 4] }));

    chart.dispose();
    const back = new StudyLink(view, () => studies);
    back.follow(cvd);
    expect(back.source?.values.length, 'a tab switched back to draws what it drew').toBe(3);

    sub.resubscribed();
    sub.event(seriesSnapshot(1, [0, 1, 2].map(minute), { delta: [3, -1, 2], cvd: [3, 2, 4] }));
    sub.event(seriesSpan(2, [minute(3), minute(3)], [minute(3)], { delta: [5], cvd: [9] }));

    const second = new StudyLink(view, () => studies);
    second.follow(cvd);
    expect(second.source).toBe(back.source);
    expect(held(second.source!, 'cvd')).toEqual([
      [minute(0), 3],
      [minute(1), 2],
      [minute(2), 4],
      [minute(3), 9],
    ]);
    await pause();
    expect(seriesSubs(rt), 'one computation').toHaveLength(1);
    expect(drawn).toEqual([0, 3, 3, 3, 4, 4]);
    back.dispose();
    second.dispose();
  });

  it('holds no values while the computation fails or the runtime refuses it, and says why', async () => {
    const { rt, studies } = desk();
    const { source, release } = studies.acquire({ ...EMA, indicator: 'ci_1', version: 3, inputs: {} });
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    expect(sub.params).toMatchObject({ indicator: 'ci_1', version: 3 });
    sub.event(seriesSnapshot(1, [at(0)], { ma: [1] }));
    sub.event(seriesSnapshot(2, [], {}, { error: { message: 'line 3: boom', line: 3 } }));
    expect(source.values.length).toBe(0);
    expect(source.status.error).toEqual({ message: 'line 3: boom', line: 3 });
    sub.event(seriesSnapshot(3, [at(0)], { ma: [1] }));
    expect(source.status.error).toBeNull();
    sub.refuse('unknown indicator ci_1');
    expect(source.values.length).toBe(0);
    expect(source.status.error?.message).toBe('unknown indicator ci_1');
    release();
  });

  it('reads where a series’ print sides come from, draws a bar with no known prints as NaN, and keeps drawn objects until an update replaces them', async () => {
    const { rt, studies } = desk();
    const { source, release } = studies.acquire({ ...EMA, indicator: 'delta', inputs: { reset: 'session' } });
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    const label = (text: string): IndicatorObjects => ({
      lines: [],
      labels: [{ time: ns(at(0)), price: 1, text, color: null, size: 'small', side: 'at' }],
      boxes: [],
    });
    const drawn = label('first');
    sub.event(
      seriesSnapshot(1, [at(0), at(1)], { delta: [3, Number.NaN] }, { aggressorSource: 'exchange', objects: drawn }),
    );
    expect(source.status.aggressorSource).toBe('exchange');
    expect(source.reading).toBe(false);
    expect(source.status.provider).toBe('mock-market');
    expect(held(source, 'delta')).toEqual([
      [at(0), 3],
      [at(1), Number.NaN],
    ]);
    sub.event(seriesSpan(2, [at(1), at(1)], [at(1)], { delta: null }));
    expect(source.objects).toEqual(drawn);
    expect(source.status.aggressorSource).toBeNull();
    const next = label('second');
    sub.event(seriesSpan(3, [at(1), at(1)], [at(1)], { delta: [4] }, { objects: next }));
    expect(source.objects).toEqual(next);
    sub.event(seriesSnapshot(4, [at(1)], { delta: [4] }));
    expect(source.objects).toBeNull();
    release();
  });

  it('follows the print bars the chart draws, from their first bar, and never reaches them back', async () => {
    const TICKS: PrintBars = { kind: 'tick', size: 500 };
    let first = 0;
    const printed = (): PrintBarsOutput => ({
      instrument: 'QQQ',
      bars: TICKS,
      priceDecimals: 2,
      columns: ['t', 'o', 'h', 'l', 'c', 'v'],
      candles: candles(first, 9).bars,
      lastBarOpen: true,
      gaps: [],
      filling: false,
    });
    const rt = fakeRuntime({ answers: { 'market.get_print_bars': printed } });
    const chart = printBarSources().acquire('QQQ', TICKS);
    const studies = new StudySources();
    const ema = studies.acquire({ ...EMA, printBars: TICKS });
    const sub = await vi.waitFor(() => rt.sub('indicators.series'));
    expect(sub.params).toEqual({
      indicator: 'ema',
      inputs: { length: 9, source: 'close' },
      instrument: 'QQQ',
      tf: '5m',
      from: ns(at(0)),
      printBars: TICKS,
    } satisfies SeriesParams);
    expect(rt.toolCalls('market.get_print_bars')).toHaveLength(1);
    first = -5;
    chart.source.reload();
    await vi.waitFor(() => expect(chart.source.series.time[0]).toBe(at(-5)));
    await pause();
    expect(rt.toolCalls('indicators.reach')).toHaveLength(0);
    const time = studies.acquire(EMA);
    expect(time.source).not.toBe(ema.source);
    sub.resubscribed();
    const again = await resubscribed(rt, sub);
    expect(again.params, 'print bars a reconnect finds moved are asked for again from their first bar').toMatchObject({
      from: ns(at(-5)),
      printBars: TICKS,
    });
    for (const s of [ema, time, chart]) s.release();
  });
});
