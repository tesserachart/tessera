import { FlowState, TESSERA_GROUPING, type AskTarget, type Grouping, type SessionProfileData } from '@tessera/chart';
import {
  msToNs,
  type BigTrade,
  type BigTradeTier,
  type BigTradesOutput,
  type CompactCell,
  type CompactFootprint,
  type DepthKind,
  type DepthUpdate,
  type FootprintOutput,
  type FootprintUpdate,
  type LayerKindsOutput,
  type Level,
  type ProfileOutput,
  type TradesOutput,
  type TradesUpdate,
  type VolumeProfileOutput,
} from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bubbleTipCards } from '../src/chart/bubbleTip.ts';
import { noteFrom, rowTicksOf } from '../src/chart/layers/orderflow/common.ts';
import { orderFlowCommands, toggleKind } from '../src/chart/orderflowCommands.ts';
import { askLabel, askQuestion } from '../src/chart/orderflowAsk.ts';
import { isOrderFlow, withOrderFlow } from '../src/chart/templates/builtin.ts';
import { requirementWords, unavailableKinds } from '../src/chart/settings/availability.ts';
import { BigTradeView, LOWER_AFTER_MS, type BigTradeFilter } from '../src/market/flow/bigTrades.ts';
import { Lifetime } from '../src/app/lifetime.ts';
import { FlowHub, Refill, type InstrumentFlow } from '../src/market/flow/hub.ts';
import { addPrints, OPEN_SPAN_REFRESH_MS, profileData, sessionLabel, withoutRth } from '../src/market/flow/profiles.ts';
import { fakeRuntime, type FakeRuntime } from './support/fakeRuntime.ts';
import { readsAgain } from './support/readsAgain.ts';
import { ns } from './support/time.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { OLDER_HISTORY_REFUSED } from '../src/shell/deskWords.ts';

const counted = (cells: readonly [number, number, number][]): CompactCell[] =>
  cells.map(([price, bid, ask]) => [price, bid, ask, bid + ask > 0 ? 1 : 0]);

const T0 = Date.parse('2026-10-02T14:42:00-04:00');
const source = { provider: 'rithmic-test' };

const open = (rt: FakeRuntime, topic: string) => rt.subscriptions.filter((s) => s.topic === topic && s.open);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const quiet = () => vi.advanceTimersByTimeAsync(10);

const DAY = 86_400_000;

const within = (trades: readonly BigTrade[], input: unknown) => {
  const span = input as { from: number; to: number };
  return trades.filter((t) => t.t >= span.from && t.t < span.to);
};

const tradesOutput = (over: Partial<TradesOutput> = {}): TradesOutput => ({
  instrument: 'ESZ6.CME',
  priceDecimals: 2,
  columns: [],
  trades: [],
  aggregated: true,
  prints: [],
  last: [],
  threshold: null,
  aggressorSource: 'exchange',
  gaps: [],
  filling: false,
  truncated: false,
  provider: 'rithmic-test',
  ...over,
});

const footprintOutput = (
  bars: CompactFootprint[],
  over: Pick<FootprintOutput, 'lastBarOpen' | 'truncated'> & Partial<FootprintOutput>,
): FootprintOutput => ({
  loaded: { sessions: 1, held: 1, refused: false },
  instrument: 'ESZ6.CME',
  tf: '1m',
  priceDecimals: 2,
  row: 0.25,
  bars,
  gaps: [],
  filling: false,
  firstOpen: bars[0]?.t ?? null,
  imbalanceRatio: 3,
  imbalanceMinVolume: 0,
  imbalanceMinDifference: 0,
  imbalanceIncludeZero: false,
  stackedImbalances: [],
  provider: 'rithmic-test',
  ...over,
});

const fpBar = (t: number, cells: [number, number, number][]): CompactFootprint => ({
  t: ns(t),
  row: 0.25,
  cells: counted(cells),
  poc: null,
  volume: 0,
  delta: 0,
  deltaHigh: null,
  deltaLow: null,
  aggressorSource: 'exchange',
});

const footprintUpdate = (bar: CompactFootprint, over: Partial<FootprintUpdate> = {}): FootprintUpdate => ({
  instrument: 'NQZ6.CME',
  tf: '5m',
  bar,
  closed: false,
  partial: false,
  seq: 1,
  source,
  ...over,
});

const byTier = (t: 'low' | 'medium' | 'high'): BigTradeFilter => ({ kind: 'auto', tier: t });
const AUTO = byTier('low');
const size = (min: number, max: number | null = null): BigTradeFilter => ({ kind: 'size', min, max });

function bigTrades(flow: InstrumentFlow, filter: BigTradeFilter, grouping: Grouping = TESSERA_GROUPING, days = 10) {
  const { feed, release } = flow.useBigTrades(grouping, days);
  const demand = feed.demand(filter);
  let view = new BigTradeView(feed, filter);
  return {
    feed,
    get view() {
      return view;
    },
    set(next: BigTradeFilter) {
      demand.set(next);
      view = new BigTradeView(feed, next);
    },
    release() {
      demand.drop();
      release();
    },
  };
}

const threshold = (n: number) => tradesOutput({ threshold: { size: n, floor: 2, orders: 900, sessions: 5 } });

const bigTradesOutput = (over: Partial<BigTradesOutput> = {}): BigTradesOutput => ({
  loaded: { sessions: 1, held: 1, refused: false },
  instrument: 'ESZ6.CME',
  priceDecimals: 2,
  from: ns(T0 - 86_400_000),
  to: ns(T0),
  rule: {
    mode: 'auto',
    tiers: ['high', 'medium', 'low'],
    minSize: null,
    maxSize: null,
    cuts: { low: 8, medium: 16, high: 30 },
    floor: 8,
    minNotional: 0,
    multiplier: 50,
    joinOrders: true,
    reachLimit: true,
    continuationMs: 0,
    sizeNow: 8,
    modelOrders: 900,
    modelSessions: 5,
    modelMinutes: 6900,
    reachTicks: Array.from({ length: 46 }, () => 2),
    reachFrom: ns(T0 - 60 * 60_000),
  },
  trades: [],
  count: 0,
  tiers: { high: 0, medium: 0, low: 0 },
  buyVolume: 0,
  sellVolume: 0,
  orders: 0,
  gaps: [],
  filling: false,
  aggressorSource: 'exchange',
  provider: 'rithmic-test',
  ...over,
});

const volumeProfile = (profiles: ProfileOutput[], filling = false): VolumeProfileOutput => ({
  loaded: { sessions: 1, held: 1, refused: false },
  instrument: 'ESZ6.CME',
  priceDecimals: 2,
  mode: 'session',
  period: 'session',
  valueAreaPercent: 70,
  columns: [],
  profiles,
  filling,
  aggressorSource: 'exchange',
  provider: 'rithmic-test',
});

describe('the order-flow hub', () => {
  it('shares one instrument’s flow and subscribes each stream only while something uses it', async () => {
    const rt = fakeRuntime();
    const now = { t: T0 };
    const hub = new FlowHub({ now: () => now.t }, { keepMs: 0 });
    const a = hub.acquire('NQ', 0.25, 2);
    const b = hub.acquire('NQ', 0.25, 2);
    expect(a.flow).toBe(b.flow);
    const releaseBook = a.flow.useBook();
    const releaseBook2 = b.flow.useBook();
    await vi.waitFor(() => expect(open(rt, 'market.depth')).toHaveLength(1));
    releaseBook();
    await quiet();
    expect(open(rt, 'market.depth')).toHaveLength(1);
    expect(rt.subscriptions).toHaveLength(1);
    releaseBook2();
    await vi.waitFor(() => expect(open(rt, 'market.depth')).toHaveLength(0));
    a.release();
    expect(hub.size).toBe(1);
    b.release();
    expect(hub.size).toBe(0);
  });

  it('keeps an instrument’s flow and its streams live a while after its last view goes', async () => {
    vi.useFakeTimers();
    try {
      const rt = fakeRuntime();
      const hub = new FlowHub({ now: () => T0 }, { keepMs: 60_000, maxIdle: 1 });
      const first = hub.acquire('NQ', 0.25, 2);
      const releaseBook = first.flow.useBook();
      const releaseTrades = first.flow.useTrades();
      await vi.waitFor(() => expect(open(rt, 'market.depth')).toHaveLength(1));
      releaseTrades();
      releaseBook();
      first.release();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(open(rt, 'market.depth')).toHaveLength(1);
      expect(open(rt, 'market.trades')).toHaveLength(1);
      expect(hub.size).toBe(1);
      const back = hub.acquire('NQ', 0.25, 2);
      expect(back.flow).toBe(first.flow);
      const releaseBook2 = back.flow.useBook();
      expect(rt.subscriptions.filter((x) => x.topic === 'market.depth')).toHaveLength(1);
      releaseBook2();
      back.release();
      const es = hub.acquire('ES', 0.25, 2);
      es.release();
      expect(hub.size).toBe(1);
      await vi.waitFor(() => expect(open(rt, 'market.depth')).toHaveLength(0));
      expect(open(rt, 'market.trades')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hub.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the book by its sequence: a gap resubscribes for a fresh snapshot, a heartbeat keeps it current', async () => {
    const rt = fakeRuntime();
    const now = { t: T0 };
    const hub = new FlowHub({ now: () => now.t });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    flow.useBook();
    const changes = vi.fn();
    flow.bookChanged.on(changes);
    const level = (p: number, s: number): [number, number] => [p, s];
    const depth = (seq: number, kind: DepthKind, bids: [number, number][], asks: [number, number][]): DepthUpdate => ({
      instrument: 'NQZ6.CME',
      ts: ns(T0),
      seq,
      kind,
      levels: 10,
      bids,
      asks,
      source,
    });
    const sub = await vi.waitFor(() => rt.sub('market.depth'));
    expect(sub.params).toEqual({ instrument: 'NQ' });
    sub.event(depth(5, 'snapshot', [level(100, 3)], [level(100.25, 4)]), 0);
    await vi.waitFor(() => expect(flow.book.bestBid).toBe(400));
    sub.event(depth(6, 'delta', [level(100, 9)], []), 1);
    await vi.waitFor(() => expect(flow.book.sizeAt('bid', 400)).toBe(9));
    now.t += 1500;
    sub.event(depth(6, 'heartbeat', [], []), 3);
    await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(3));
    expect(flow.book.isStale(now.t)).toBe(false);
    sub.event(depth(8, 'delta', [level(99.75, 1)], []), 4);
    await vi.waitFor(() => expect(rt.subscriptions.filter((s) => s.topic === 'market.depth')).toHaveLength(2));
    expect(sub.open).toBe(false);
    expect(open(rt, 'market.depth')).toHaveLength(1);
    expect(flow.book.seq).toBeNull();
    release();
  });

  it('starts the book over when its stream lost events or came back on a new connection, and says why it was refused', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    flow.useBook();
    const status = vi.fn();
    flow.statusChanged.on(status);
    const snapshot = (seq: number): DepthUpdate => ({
      instrument: 'NQZ6.CME',
      ts: ns(T0),
      seq,
      kind: 'snapshot',
      levels: 10,
      bids: [[100, 3]],
      asks: [[100.25, 4]],
      source,
    });
    const first = await vi.waitFor(() => rt.sub('market.depth'));
    first.event(snapshot(5), 0);
    await vi.waitFor(() => expect(flow.book.seq).toBe(5));
    first.gap();
    const second = await vi.waitFor(() => {
      const s = rt.sub('market.depth');
      expect(s).not.toBe(first);
      return s;
    });
    expect(first.open).toBe(false);
    expect(flow.book.seq).toBeNull();
    second.event(snapshot(9), 0);
    await vi.waitFor(() => expect(flow.book.seq).toBe(9));
    second.resubscribed();
    await vi.waitFor(() => expect(flow.book.seq).toBeNull());
    expect(second.open).toBe(true);
    second.event(snapshot(2), 0);
    await vi.waitFor(() => expect(flow.book.seq).toBe(2));
    second.refuse('Paper offers no depth for NQ');
    await vi.waitFor(() => expect(flow.depthError).toBe('Paper offers no depth for NQ'));
    expect(status).toHaveBeenCalledTimes(1);
    expect(second.open).toBe(true);
    second.active();
    second.event(snapshot(4), 0);
    await vi.waitFor(() => expect(flow.book.seq).toBe(4));
    expect(rt.subscriptions.filter((s) => s.topic === 'market.depth')).toHaveLength(2);
    release();
  });

  it('takes a book the runtime sends again on the same stream in place of updates it lost, asking nothing', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    flow.useBook();
    const depth = (seq: number, kind: DepthKind, bid: number): DepthUpdate => ({
      instrument: 'NQZ6.CME',
      ts: ns(T0),
      seq,
      kind,
      levels: 10,
      bids: [[100, bid]],
      asks: [[100.25, 4]],
      source,
    });
    const sub = await vi.waitFor(() => rt.sub('market.depth'));
    sub.event(depth(5, 'snapshot', 3), 0);
    sub.event(depth(6, 'delta', 7), 1);
    await vi.waitFor(() => expect(flow.book.sizeAt('bid', 400)).toBe(7));
    sub.event(depth(40, 'snapshot', 12), 0);
    sub.event(depth(39, 'delta', 2), 2);
    sub.event(depth(41, 'delta', 15), 3);
    await vi.waitFor(() => expect(flow.book.seq).toBe(41));
    expect(flow.book.sizeAt('bid', 400)).toBe(15);
    expect(rt.subscriptions.filter((s) => s.topic === 'market.depth')).toHaveLength(1);
    release();
  });

  it('keeps the tape by the print count and joins prints into orders as they arrive', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    flow.useTrades();
    const batch = (seq: number, trades: TradesUpdate['trades']): TradesUpdate => ({
      instrument: 'ESZ6.CME',
      seq,
      trades,
      aggressorSource: 'inferred',
      source,
    });
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    expect(sub.params).toEqual({ instruments: ['ES'] });
    sub.event(
      batch(3, [
        [ns(T0), 5800, 2, 1, 7],
        [ns(T0), 5800.25, 3, 1, 7],
        [ns(T0 + 5), 5800, 1, -1],
      ]),
      0,
    );
    await vi.waitFor(() => expect(flow.tape.length).toBe(3));
    expect(flow.agg.length).toBe(2);
    expect(flow.agg.at(0).size).toBe(5);
    expect(flow.info.aggressorSource).toBe('inferred');
    sub.event(batch(3, [[ns(T0 + 5), 5800, 1, -1]]), 1);
    await quiet();
    expect(flow.tape.length).toBe(3);
    expect(sub.open).toBe(true);
    sub.event(batch(9, [[ns(T0 + 9), 5800, 1, -1]]), 2);
    await vi.waitFor(() => expect(rt.subscriptions.filter((s) => s.topic === 'market.trades')).toHaveLength(2));
    expect(sub.open).toBe(false);
    expect(open(rt, 'market.trades')).toHaveLength(1);
    release();
  });

  it('reads footprints at one-tick rows, holds live updates until the history is in, and reads older pages', async () => {
    const bar = (t: number, cells: [number, number, number][]): CompactFootprint => ({
      t: ns(t),
      row: 0.25,
      cells: counted(cells),
      poc: null,
      volume: 0,
      delta: 0,
      deltaHigh: 4,
      deltaLow: -2,
      aggressorSource: 'exchange',
    });
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    const feed = footprints.feed;
    expect(feed.status).toEqual({ reading: true, error: null });
    const sub = await vi.waitFor(() => rt.sub('market.footprint'));
    expect(sub.params).toEqual({ instrument: 'ES', tf: '1m', rowTicks: 1 });
    sub.event({
      instrument: 'ESZ6.CME',
      tf: '1m',
      bar: bar(T0, [[5800, 3, 6]]),
      closed: false,
      partial: true,
      seq: 1,
      source,
    });
    const latest = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(latest.input).toEqual({ instrument: 'ES', tf: '1m', rowTicks: 1, limit: 200, daysToLoad: 2 });
    await quiet();
    expect(feed.store.length).toBe(0);
    latest.ok(
      footprintOutput([bar(T0 - 60_000, [[5800, 1, 2]]), bar(T0, [[5800, 3, 1]])], {
        lastBarOpen: true,
        truncated: true,
      }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(2));
    expect(feed.store.get(T0)!.ask[0]).toBe(6);
    expect(feed.status.reading).toBe(false);
    const older = feed.ensureFrom(T0 - 120_000);
    const page = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(page.input).toMatchObject({ rowTicks: 1, limit: 200, to: msToNs(T0 - 60_001) });
    expect(feed.status.reading, 'paging back older bars is not a first read').toBe(false);
    page.ok(footprintOutput([bar(T0 - 120_000, [[5799.75, 5, 5]])], { lastBarOpen: false, truncated: false }));
    await older;
    expect(feed.status.reading).toBe(false);
    expect(feed.store.firstTime).toBe(T0 - 120_000);
    expect(feed.store.length).toBe(3);
    footprints.release();
    release();
  });

  it('asks for its days to load, draws each answer while the newest bars fill, and says how far it is', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('1m', 3);
    const feed = footprints.feed;
    const loading = (held: number) => ({ sessions: 3, held, refused: false });
    const first = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(first.input).toMatchObject({ limit: 200, daysToLoad: 3 });
    first.ok(footprintOutput([], { lastBarOpen: false, truncated: false, filling: true, loaded: loading(0) }));
    await vi.waitFor(() => expect(feed.status.loaded).toEqual({ loaded: loading(0), filling: true }));

    await readsAgain(1);
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0, [[29_700, 1, 2]])], {
        lastBarOpen: true,
        truncated: false,
        filling: true,
        loaded: loading(1),
      }),
    );
    await vi.waitFor(() => expect(feed.store.length, 'the newest bars draw while older ones fill').toBe(1));
    expect(feed.status.loaded).toEqual({ loaded: loading(1), filling: true });

    await readsAgain(2);
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0 - 60_000, [[29_699, 4, 1]]), fpBar(T0, [[29_700, 1, 2]])], {
        lastBarOpen: true,
        truncated: false,
        loaded: loading(3),
      }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(2));
    expect(feed.status.loaded, 'every session held says nothing more').toBeUndefined();
    await readsAgain(3);
    expect(rt.toolCalls('market.get_footprint'), 'a settled answer is not asked again').toHaveLength(3);
    footprints.release();
    release();
  });

  it('draws an older page the runtime is still filling at once, then lands its settled answer in one change', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    const feed = footprints.feed;
    await vi.waitFor(() => rt.sub('market.footprint'));
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0, [[29_700, 1, 2]])], { lastBarOpen: true, truncated: false }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(1));

    const older = feed.ensureFrom(T0 - 120_000);
    const filling = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(filling.input).toMatchObject({ to: msToNs(T0 - 1) });
    const hole = { from: ns(T0 - 120_000), to: ns(T0 - 60_000) };
    filling.ok(
      footprintOutput([fpBar(T0 - 60_000, [[29_699, 1, 1]])], {
        lastBarOpen: false,
        truncated: false,
        firstOpen: ns(T0 - 120_000),
        gaps: [hole],
        filling: true,
      }),
    );
    await older;
    expect(feed.store.length, 'a filling answer is drawn').toBe(2);
    expect(feed.gaps, 'a gap the runtime is filling is not marked').toEqual([]);
    expect(feed.exhausted).toBe(false);
    const lengths: number[] = [];
    feed.changed.on(() => lengths.push(feed.store.length));

    await readsAgain(1);
    const still = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(still.input).toEqual(filling.input);
    still.ok(
      footprintOutput([fpBar(T0 - 60_000, [[29_699, 1, 1]])], {
        lastBarOpen: false,
        truncated: false,
        firstOpen: ns(T0 - 120_000),
        gaps: [hole],
        filling: true,
      }),
    );
    await quiet();
    expect(lengths, 'an answer still filling is not applied').toEqual([]);

    await readsAgain(2);
    const settled = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(settled.input).toEqual(filling.input);
    settled.ok(
      footprintOutput([fpBar(T0 - 120_000, [[29_699, 4, 1]]), fpBar(T0 - 60_000, [[29_699, 2, 2]])], {
        lastBarOpen: false,
        truncated: false,
      }),
    );
    await vi.waitFor(() => expect(lengths).toEqual([3]));
    expect(feed.store.firstTime).toBe(T0 - 120_000);
    expect(feed.gaps).toEqual([]);
    await readsAgain(3);
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(4);
    footprints.release();
    release();
  });

  it('reads older footprints a span needs all at once, a page of time each, then pages on from there', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    const feed = footprints.feed;
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0, [[5800, 1, 1]])], { lastBarOpen: true, truncated: true }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(1));
    const page = 200 * 60_000;
    const older = feed.ensureFrom(T0 - 2.5 * page);
    await vi.waitFor(() => expect(rt.calls.filter((c) => !c.settled)).toHaveLength(3));
    const windows = rt.toolCalls('market.get_footprint').slice(1);
    expect(windows.map((c) => c.input)).toEqual(
      [0, 1, 2].map((k) => ({
        instrument: 'ES',
        tf: '1m',
        rowTicks: 1,
        limit: 200,
        daysToLoad: 2,
        from: msToNs(Math.max(T0 - 2.5 * page, T0 - (k + 1) * page)),
        to: msToNs(T0 - 1 - k * page),
      })),
    );
    windows.forEach((c, k) =>
      c.ok(
        footprintOutput([fpBar(T0 - (k + 1) * 60_000 * 150, [[5800, 1, 1]])], {
          lastBarOpen: false,
          truncated: k === 2,
        }),
      ),
    );
    const next = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(feed.store.length, 'pages wait for the end of the run').toBe(1);
    expect(next.input, 'a window the budget cut pages on from its first open').toMatchObject({
      limit: 200,
      to: msToNs(T0 - 450 * 60_000 - 1),
    });
    expect(next.input).not.toHaveProperty('from');
    const lengths: number[] = [];
    const off = feed.changed.on(() => lengths.push(feed.store.length));
    next.ok(footprintOutput([fpBar(T0 - 2.5 * page, [[5800, 1, 1]])], { lastBarOpen: false, truncated: true }));
    await older;
    off();
    expect(lengths, 'the run lands in one change').toEqual([5]);
    expect(feed.store.firstTime).toBe(T0 - 2.5 * page);
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(5);
    footprints.release();
    release();
  });

  it('draws spans the runtime is still filling with the others, marks none of their gaps, then reads again only those', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    const feed = footprints.feed;
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0, [[5800, 1, 1]])], { lastBarOpen: true, truncated: true }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(1));
    const page = 200 * 60_000;
    const older = feed.ensureFrom(T0 - 2.5 * page);
    await vi.waitFor(() => expect(rt.calls.filter((c) => !c.settled)).toHaveLength(3));
    const [whole, pulling, beyond] = rt.toolCalls('market.get_footprint').slice(1);
    const hole = { from: ns(T0 - 1.5 * page), to: ns(T0 - 1.2 * page) };
    whole!.ok(footprintOutput([fpBar(T0 - 0.5 * page, [[5800, 1, 1]])], { lastBarOpen: false, truncated: false }));
    pulling!.ok(
      footprintOutput([fpBar(T0 - 1.2 * page, [[5800, 1, 1]])], {
        lastBarOpen: false,
        truncated: false,
        gaps: [hole],
        filling: true,
      }),
    );
    beyond!.ok(footprintOutput([fpBar(T0 - 2.2 * page, [[5800, 1, 1]])], { lastBarOpen: false, truncated: false }));
    await older;
    expect(feed.store.length).toBe(4);
    expect(feed.gaps, 'a gap the runtime is filling is not marked').toEqual([]);
    expect(rt.toolCalls('market.get_footprint'), 'the run reached what the view wants').toHaveLength(4);

    await readsAgain(1);
    const again = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(again.input).toEqual(pulling!.input);
    again.ok(
      footprintOutput([fpBar(T0 - 1.4 * page, [[5800, 1, 1]]), fpBar(T0 - 1.2 * page, [[5800, 1, 1]])], {
        lastBarOpen: false,
        truncated: false,
      }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(5));
    expect(feed.gaps).toEqual([]);
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(5);
    footprints.release();
    release();
  });

  it('pages back until an answer says the connection has no older bar, then asks no more', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    const feed = footprints.feed;
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0, [[5800, 1, 1]])], { lastBarOpen: true, truncated: false }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(1));
    const older = feed.ensureFrom(T0 - 10 * 60_000);
    const first = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(first.input).toMatchObject({ to: msToNs(T0 - 1) });
    first.ok(
      footprintOutput([], {
        lastBarOpen: false,
        truncated: false,
        firstOpen: ns(T0 - 3 * 60_000),
        gaps: [{ from: ns(T0 - 3 * 60_000), to: ns(T0) }],
      }),
    );
    const last = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(last.input, 'an answer with no bars still pages on by its first open').toMatchObject({
      to: msToNs(T0 - 3 * 60_000 - 1),
    });
    last.ok(
      footprintOutput([fpBar(T0 - 4 * 60_000, [[5800, 2, 2]])], {
        lastBarOpen: false,
        truncated: false,
        firstOpen: null,
      }),
    );
    await older;
    expect(feed.exhausted).toBe(true);
    expect(feed.store.firstTime).toBe(T0 - 4 * 60_000);
    expect(feed.gaps).toEqual([{ from: T0 - 3 * 60_000, to: T0 }]);
    await feed.ensureFrom(T0 - 60 * 60_000);
    await quiet();
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(3);
    footprints.release();
    release();
  });

  it('keeps the footprints live after a first history read the runtime could not answer yet', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('5m');
    const feed = footprints.feed;
    const sub = await vi.waitFor(() => rt.sub('market.footprint'));
    sub.event(footprintUpdate(fpBar(T0, [[29_700, 1, 2]])), 0);
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).fail('unavailable', 'connecting to Rithmic');
    sub.event(footprintUpdate(fpBar(T0, [[29_700, 1, 3]]), { partial: true }));
    await readsAgain(1);
    const again = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(2);
    again.ok(footprintOutput([], { lastBarOpen: false, truncated: true }));
    await vi.waitFor(() => expect(feed.store.get(T0)?.ask[0]).toBe(3));
    expect(feed.status).toEqual({ reading: false, error: null });
    sub.event(footprintUpdate(fpBar(T0, [[29_700, 4, 3]]), { partial: true }));
    await vi.waitFor(() => expect(feed.store.get(T0)?.bid[0]).toBe(4));
    footprints.release();
    release();
  });

  it('draws each footprint answer the runtime is still filling at once, then the settled answer', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('5m');
    const feed = footprints.feed;
    const lengths: number[] = [];
    feed.changed.on(() => lengths.push(feed.store.length));
    const sub = await vi.waitFor(() => rt.sub('market.footprint'));
    const hole = { from: ns(T0 - 600_000), to: ns(T0) };
    const filling = (bars: CompactFootprint[]) =>
      footprintOutput(bars, {
        lastBarOpen: true,
        truncated: false,
        firstOpen: ns(T0 - 600_000),
        gaps: [hole],
        filling: true,
      });
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(filling([fpBar(T0, [[29_700, 1, 2]])]));
    sub.event(footprintUpdate(fpBar(T0, [[29_700, 1, 3]]), { partial: true }), 0);
    await quiet();
    expect(feed.store.length, 'a filling answer is data').toBe(1);
    expect(feed.status).toEqual({ reading: false, error: null });
    expect(feed.gaps, 'a gap the runtime is filling is not marked').toEqual([]);
    await readsAgain(1);
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      filling([fpBar(T0 - 300_000, [[29_699, 1, 1]]), fpBar(T0, [[29_700, 1, 2]])]),
    );
    await quiet();
    expect(feed.store.get(T0 - 300_000), 'an answer still filling is drawn as it comes').toBeDefined();
    expect(feed.store.get(T0)?.ask[0], 'the live bar keeps what the stream added').toBe(3);
    const before = lengths.length;
    await readsAgain(2);
    const settled = await vi.waitFor(() => rt.pending('market.get_footprint'));
    sub.event(footprintUpdate(fpBar(T0, [[29_700, 2, 3]]), { partial: true }));
    settled.ok(
      footprintOutput(
        [fpBar(T0 - 600_000, [[29_699, 4, 4]]), fpBar(T0 - 300_000, [[29_699, 4, 4]]), fpBar(T0, [[29_700, 1, 2]])],
        {
          lastBarOpen: true,
          truncated: false,
        },
      ),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(3));
    expect(
      lengths.slice(before).filter((n) => n !== 2),
      'the settled bars land at once',
    ).toEqual([3]);
    expect(feed.store.get(T0)?.ask[0], 'the live bar keeps what the stream added').toBe(3);
    expect(feed.gaps).toEqual([]);
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(3);
    footprints.release();
    release();
  });

  it('retries a footprint read that got no answer, in trader words, and does not stay on reading', async () => {
    const now = { t: T0 };
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => now.t });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('5m');
    const feed = footprints.feed;
    await vi.waitFor(() => rt.sub('market.footprint'));
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).fail(
      'timeout',
      'tools.invoke: no response within 20000ms',
    );
    await readsAgain(1);
    const again = await vi.waitFor(() => rt.pending('market.get_footprint'));
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(2);
    expect(feed.status).toEqual({ reading: true, error: null });
    expect(JSON.stringify(feed.status)).not.toMatch(/20000ms/i);
    now.t = T0 + 60_000;
    again.ok(footprintOutput([], { lastBarOpen: false, truncated: true }));
    await vi.waitFor(() => expect(feed.status).toEqual({ reading: false, error: null }));
    footprints.release();
    release();
  });

  it('reads the session profiles and the big trades again when a read’s answer never came', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const profiles = flow.useProfiles();
    profiles.feed.periods('session');
    const big = bigTrades(flow, size(5));
    (await vi.waitFor(() => rt.pending('market.get_volume_profile'))).timedOut();
    const first = await vi.waitFor(() => rt.pending('market.get_big_trades'));
    first.timedOut();
    await quiet();
    expect(profiles.feed.status.error).toBeNull();
    expect(big.feed.status.error).toBeNull();
    await readsAgain(1);
    (await vi.waitFor(() => rt.pending('market.get_volume_profile'))).ok(volumeProfile([]));
    await readsAgain(1);
    const again = await vi.waitFor(() => rt.pending('market.get_big_trades'));
    expect(again.input).toEqual(first.input);
    again.ok(bigTradesOutput());
    await vi.waitFor(() => expect(profiles.feed.status).toEqual({ reading: false, error: null }));
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(3));
    expect(big.feed.status.error).toBeNull();
    expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(2);
    profiles.release();
    big.release();
    release();
  });

  it('says a refused stream stopped until the runtime takes it, whatever a read says meanwhile', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('5m');
    const feed = footprints.feed;
    const sub = await vi.waitFor(() => rt.sub('market.footprint'));
    sub.refuse('connecting to Rithmic');
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([fpBar(T0, [[29_700, 1, 2]])], { lastBarOpen: true, truncated: true }),
    );
    await vi.waitFor(() => expect(feed.store.length).toBe(1));
    expect(feed.status.error).toBe('connecting to Rithmic');
    sub.active();
    await vi.waitFor(() => expect(feed.status.error).toBeNull());
    footprints.release();
    release();
  });

  it('reads the latest bars once at a time after missed updates', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const footprints = flow.useFootprints('5m');
    const feed = footprints.feed;
    const sub = await vi.waitFor(() => rt.sub('market.footprint'));
    (await vi.waitFor(() => rt.pending('market.get_footprint'))).ok(
      footprintOutput([], { lastBarOpen: false, truncated: true }),
    );
    await vi.waitFor(() => expect(feed.status.reading).toBe(false));
    for (let k = 1; k <= 4; k++) sub.event(footprintUpdate(fpBar(T0, [[29_700, k, k]]), { partial: true }));
    sub.gap();
    await quiet();
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(2);
    rt.pending('market.get_footprint').ok(
      footprintOutput([fpBar(T0, [[29_700, 4, 4]])], { lastBarOpen: true, truncated: true }),
    );
    await vi.waitFor(() => expect(rt.toolCalls('market.get_footprint')).toHaveLength(3));
    rt.pending('market.get_footprint').ok(
      footprintOutput([fpBar(T0, [[29_700, 4, 4]])], { lastBarOpen: true, truncated: true }),
    );
    await quiet();
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(3);
    expect(feed.store.get(T0)?.ask[0]).toBe(4);
    footprints.release();
    release();
  });

  it('reads Tessera’s size now once', async () => {
    const rt = fakeRuntime({
      answers: {
        'market.get_trades': () => tradesOutput({ threshold: { size: 4, floor: 4, orders: 900, sessions: 5 } }),
      },
    });
    const hub = new FlowHub({ now: () => T0 + 1000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    flow.loadThreshold();
    await vi.waitFor(() => expect(flow.threshold?.size).toBe(4));
    expect(rt.toolCalls('market.get_trades')[0]!.input).toEqual({
      instrument: 'ES',
      minSize: 'auto',
      aggregate: true,
      limit: 1,
    });
    flow.loadThreshold();
    await quiet();
    expect(rt.toolCalls('market.get_trades')).toHaveLength(1);
    release();
  });

  it('tiers live events the runtime’s way once the newest answer is in, Auto showing the tiered ones', async () => {
    const rt = fakeRuntime({ answers: { 'market.get_trades': () => threshold(8) } });
    const hub = new FlowHub({ now: () => T0 + 1000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const auto = bigTrades(flow, AUTO);
    const all = bigTrades(flow, size(3));
    const big = bigTrades(flow, size(25));
    const medium = bigTrades(flow, byTier('medium'));
    const high = bigTrades(flow, byTier('high'));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    const ms = (n: number) => ns(T0) + n * 1e6;
    sub.event(
      {
        instrument: 'ES',
        seq: 4,
        trades: [
          [ms(0), 5800, 3, 1],
          [ms(10), 5800, 5, 1],
          [ms(20), 5800, 9, 1],
          [ms(30), 5800, 20, 1],
          [ms(40), 5800, 30, 1],
        ],
        aggressorSource: 'exchange',
        source,
      },
      0,
    );
    await vi.waitFor(() => expect(flow.tape.seq).toBe(4));
    const shown = (b: typeof auto) => b.view.between(T0 - 1000, T0 + 1000).map((t) => [t.size, t.tier]);
    expect(shown(all), 'live events wait for the newest answer').toEqual([]);
    const rule = { ...bigTradesOutput().rule, floor: 4, minNotional: 2_000_000 };
    const answer = () => {
      for (const c of rt.toolCalls('market.get_big_trades')) if (!c.settled) c.ok(bigTradesOutput({ rule }));
    };
    await vi.waitFor(() => {
      answer();
      expect(shown(all)).toHaveLength(5);
    });
    expect(shown(all), 'under the floor, then under the notional, then the cuts').toEqual([
      [3, null],
      [5, null],
      [9, 'low'],
      [20, 'medium'],
      [30, 'high'],
    ]);
    expect(shown(auto)).toEqual([
      [9, 'low'],
      [20, 'medium'],
      [30, 'high'],
    ]);
    expect(shown(big)).toEqual([[30, 'high']]);
    expect(shown(medium), 'Medium drops the Low tier').toEqual([
      [20, 'medium'],
      [30, 'high'],
    ]);
    expect(shown(high)).toEqual([[30, 'high']]);
    expect(auto.view.between(T0 - 1000, T0 + 1000)[0]).toMatchObject({ size: 9, side: 1, price: 5800, ref: 'live:2' });
    sub.event({ instrument: 'ES', seq: 9, trades: [], aggressorSource: 'exchange', source }, 0);
    await vi.waitFor(() => expect(shown(all)).toHaveLength(0));
    for (const b of [auto, all, big, medium, high]) b.release();
    release();
  });

  it('while the model is still sizing, Auto shows no live event however big, and a size shows its events untiered', async () => {
    const rt = fakeRuntime({
      answers: {
        'market.get_trades': () => threshold(8),
        'market.get_big_trades': () =>
          bigTradesOutput({
            rule: { ...bigTradesOutput().rule, cuts: null, modelOrders: 0, modelSessions: 0, modelMinutes: 0 },
          }),
      },
    });
    const hub = new FlowHub({ now: () => T0 + 1000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const auto = bigTrades(flow, AUTO);
    const sized = bigTrades(flow, size(5));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    sub.event(
      {
        instrument: 'ES',
        seq: 1,
        trades: [
          [ns(T0), 5800, 7, 1],
          [ns(T0) + 10e6, 5800, 400, -1],
        ],
        aggressorSource: 'exchange',
        source,
      },
      0,
    );
    await vi.waitFor(() =>
      expect(sized.view.between(T0 - 1000, T0 + 1000).map((t) => [t.size, t.tier])).toEqual([
        [7, null],
        [400, null],
      ]),
    );
    expect(auto.view.between(T0 - 1000, T0 + 1000)).toEqual([]);
    expect(auto.feed.sizing).toBe(true);
    for (const b of [auto, sized]) b.release();
    release();
  });
});

describe('big trades as charts read them', () => {
  const trades = (seq: number, rows: TradesUpdate['trades']): TradesUpdate => ({
    instrument: 'ES',
    seq,
    trades: rows,
    aggressorSource: 'exchange',
    source,
  });

  it('keeps live orders as the tape grows: a span asked again hands back the same array, two spans keep theirs', async () => {
    const rt = fakeRuntime({
      answers: { 'market.get_trades': () => tradesOutput(), 'market.get_big_trades': () => bigTradesOutput() },
    });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    const feed = big.feed;
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20));
    await vi.waitFor(() => expect(feed.status.reading).toBe(false));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    const send = async (batch: TradesUpdate, seq?: number) => {
      sub.event(batch, seq);
      await vi.waitFor(() => expect(flow.tape.seq).toBe(batch.seq));
    };
    await send(
      trades(2, [
        [ns(T0), 5800, 6, 1],
        [ns(T0 + 1000), 5800.25, 1, -1],
        [ns(T0 + 2000), 5800.5, 9, -1],
      ]),
      0,
    );
    const a = feed.between(T0 - 1000, T0 + 1500);
    const b = feed.between(T0 - 1000, T0 + 30_000);
    expect(a.map((t) => t.size)).toEqual([6]);
    expect(b.map((t) => t.size)).toEqual([6, 9]);
    expect(feed.between(T0 - 1000, T0 + 1500)).toBe(a);
    expect(feed.between(T0 - 1000, T0 + 30_000)).toBe(b);
    await send(
      trades(4, [
        [ns(T0 + 3000), 5800, 1, 1],
        [ns(T0 + 4000), 5800, 1, -1],
      ]),
      1,
    );
    const b2 = feed.between(T0 - 1000, T0 + 30_000);
    expect(b2.map((t) => t.size)).toEqual([6, 9]);
    await send(trades(5, [[ns(T0 + 5000), 5800, 1, 1]]), 2);
    expect(feed.between(T0 - 1000, T0 + 30_000)).toBe(b2);
    await send(trades(6, [[ns(T0 + 6000), 5801, 4, 1]]), 3);
    await send(trades(7, [[ns(T0 + 6000), 5801, 4, 1]]), 4);
    expect(feed.between(T0 - 1000, T0 + 30_000).map((t) => t.size)).toEqual([6, 9, 8]);
    big.release();
    release();
  });

  it('after the feed reconnects, drops the prints held from before and reads the hole from history', async () => {
    const hole = T0 + 300_000;
    const inHole: BigTrade = {
      t: ns(hole),
      durationNs: 0,
      side: 'buy',
      size: 50,
      price: 5800,
      firstPrice: 5800,
      lastPrice: 5800,
      levels: 1,
      rangeTicks: 0,
      prints: 1,
      orders: 1,
      tier: 'low',
      outcome: null,
      seq: null,
    };
    const rt = fakeRuntime({
      answers: {
        'market.get_trades': () => tradesOutput(),
        'market.get_big_trades': (input) => {
          const { from, to } = input as { from: number; to: number };
          const trades = from <= inHole.t && inHole.t < to ? [inHole] : [];
          return bigTradesOutput({ trades, count: trades.length });
        },
      },
    });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    sub.event(
      {
        ...trades(2, [
          [ns(T0 + 61_000), 5800, 6, 1],
          [ns(T0 + 62_000), 5800.25, 1, -1],
        ]),
        segment: 1,
      },
      0,
    );
    await vi.waitFor(() => expect(flow.tape.seq).toBe(2));
    const epoch = flow.tape.epoch;
    expect(big.feed.between(T0, T0 + 700_000).map((t) => t.size)).toEqual([6]);

    sub.event({ ...trades(3, [[ns(T0 + 600_000), 5801, 7, 1]]), segment: 2 }, 1);
    await vi.waitFor(() => expect(flow.tape.seq).toBe(3));
    expect(flow.tape.epoch).toBeGreaterThan(epoch);
    expect(flow.tape.length).toBe(1);
    await vi.waitFor(() => expect(big.feed.between(T0, T0 + 700_000).map((t) => t.t)).toEqual([hole, T0 + 600_000]));
    big.release();
    release();
  });

  it('decides a live bubble’s outcome from the tape as later prints arrive, once', async () => {
    const rt = fakeRuntime({
      answers: { 'market.get_trades': () => tradesOutput(), 'market.get_big_trades': () => bigTradesOutput() },
    });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    const feed = big.feed;
    await vi.waitFor(() => expect(feed.status.reading).toBe(false));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    const send = async (batch: TradesUpdate, seq?: number) => {
      sub.event(batch, seq);
      await vi.waitFor(() => expect(flow.tape.seq).toBe(batch.seq));
    };
    const view = () => feed.between(T0 - 1000, T0 + 120_000);
    await send(
      trades(2, [
        [ns(T0), 5800, 6, 1],
        [ns(T0 + 1000), 5800.25, 1, -1],
      ]),
      0,
    );
    expect(view().map((t) => [t.size, t.outcome ?? null])).toEqual([[6, null]]);
    await send(trades(3, [[ns(T0 + 12_000), 5799.5, 1, -1]]), 1);
    expect(view().map((t) => t.outcome)).toEqual([{ kind: 'absorbed', reachTicks: 2, withinMs: 12_000 }]);
    const decided = view();
    await send(trades(4, [[ns(T0 + 13_000), 5801, 1, 1]]), 2);
    expect(view(), 'a decided bubble stays as it was').toBe(decided);
    big.release();
    release();
  });

  it('reaches by the half hour of the answer’s session open, whatever the clock', async () => {
    const answer = bigTradesOutput();
    const rt = fakeRuntime({
      answers: {
        'market.get_trades': () => tradesOutput(),
        'market.get_big_trades': () => ({
          ...answer,
          rule: { ...answer.rule, reachTicks: [2, 4, 2], reachFrom: ns(T0 - 45 * 60_000) },
        }),
      },
    });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    const feed = big.feed;
    await vi.waitFor(() => expect(feed.status.reading).toBe(false));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    const send = async (batch: TradesUpdate, seq?: number) => {
      sub.event(batch, seq);
      await vi.waitFor(() => expect(flow.tape.seq).toBe(batch.seq));
    };
    const view = () => feed.between(T0 - 1000, T0 + 120_000);
    await send(trades(2, [[ns(T0), 5800, 6, 1]]), 0);
    await send(trades(3, [[ns(T0 + 5_000), 5799.5, 1, -1]]), 1);
    expect(
      view().map((t) => t.outcome ?? null),
      '45 minutes after the open is its second half hour: 4 ticks',
    ).toEqual([null]);
    await send(trades(4, [[ns(T0 + 9_000), 5799, 1, -1]]), 2);
    expect(view().map((t) => t.outcome)).toEqual([{ kind: 'absorbed', reachTicks: 4, withinMs: 9_000 }]);
    big.release();
    release();
  });

  it('asks the runtime in Manual from the floor, with the grouping, a day at most per read, and filters a band on the desk', async () => {
    const sell: BigTrade = {
      t: ns(T0 - 120_000),
      durationNs: 400_000,
      side: 'sell',
      size: 40,
      price: 5799.5,
      firstPrice: 5800,
      lastPrice: 5799,
      levels: 5,
      rangeTicks: 4,
      prints: 9,
      orders: 2,
      tier: 'high',
      outcome: null,
      seq: null,
    };
    const rt = fakeRuntime({
      answers: {
        'market.get_big_trades': (input) => {
          const trades = within([sell], input);
          return bigTradesOutput({ trades, count: trades.length, orders: trades.length });
        },
      },
    });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(25, 300));
    await vi.waitFor(() => expect(big.view.between(T0 - 3_600_000, T0)).toHaveLength(1));
    const read = rt.toolCalls('market.get_big_trades')[0]!.input as Record<string, unknown> & {
      from: number;
      to: number;
    };
    expect(read).toMatchObject({ minSize: 25, joinOrders: true, reachLimit: true });
    expect(['tiers', 'maxSize'].filter((k) => k in read)).toEqual([]);
    expect(read.to - read.from).toBe(ns(DAY));
    const got = big.view.between(T0 - 3_600_000, T0);
    expect(got[0]).toMatchObject({ tier: 'high', size: 40, side: -1, levels: 5, firstPrice: 5800, lastPrice: 5799 });
    expect(got[0]!.ref).toBe(`h:${String(ns(T0 - 120_000))}`);
    big.set(size(25, 30));
    expect(big.view.between(T0 - 3_600_000, T0)).toEqual([]);
    big.release();
    release();
  });

  it('groups live prints by its own settings and asks the runtime for the same grouping', async () => {
    const rt = fakeRuntime({ answers: { 'market.get_big_trades': () => bigTradesOutput() } });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const tessera = bigTrades(flow, size(5));
    const chainOnly = bigTrades(flow, size(5), { joinOrders: false, reachLimit: false });
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    const sweep: TradesUpdate['trades'] = [0, 1, 2, 3].map((k) => [ns(T0 + 61_000) + k * 1e6, 5800 + 0.75 * k, 10, 1]);
    sub.event(trades(4, [...sweep, [ns(T0 + 62_000), 5790, 1, -1]]), 0);
    const live = (f: typeof tessera.feed) => f.between(T0 + 60_000, T0 + 63_000).map((t) => [t.size, t.prints]);
    await vi.waitFor(() =>
      expect(live(tessera.feed), 'three ticks a print stops each at the 2-tick reach').toEqual([
        [10, 1],
        [10, 1],
        [10, 1],
        [10, 1],
      ]),
    );
    expect(live(chainOnly.feed), 'without the reach the sweep is one trade').toEqual([[40, 4]]);
    const asked = (g: { joinOrders: boolean; reachLimit: boolean }) =>
      rt.toolCalls('market.get_big_trades').some((c) => {
        const input = c.input as { joinOrders: boolean; reachLimit: boolean };
        return input.joinOrders === g.joinOrders && input.reachLimit === g.reachLimit;
      });
    expect([asked(TESSERA_GROUPING), asked({ joinOrders: false, reachLimit: false })]).toEqual([true, true]);
    for (const b of [tessera, chainOnly]) b.release();
    release();
  });

  it('loads its ten days to load on open, a day per read back, a day without prints not counting', async () => {
    const hours = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    });
    const open = (ms: number) => {
      const p = Object.fromEntries(hours.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      const hour = Number(p.hour);
      if (p.weekday === 'Sat') return false;
      if (p.weekday === 'Sun') return hour >= 18;
      if (p.weekday === 'Fri') return hour < 17;
      return hour !== 17;
    };
    const rt = fakeRuntime({
      answers: {
        'market.get_big_trades': (input) => {
          const span = input as { from: number; to: number };
          let at: number | null = null;
          for (let t = span.from / 1e6; t < span.to / 1e6 && at === null; t += 1_800_000) if (open(t)) at = t;
          const trades: BigTrade[] =
            at === null
              ? []
              : [
                  {
                    t: ns(at),
                    durationNs: 0,
                    side: 'buy',
                    size: 50,
                    price: 5800,
                    firstPrice: 5800,
                    lastPrice: 5800,
                    levels: 1,
                    rangeTicks: 0,
                    prints: 1,
                    orders: 1,
                    tier: 'low',
                    outcome: null,
                    seq: null,
                  },
                ];
          return bigTradesOutput({ trades, count: trades.length, orders: at === null ? 0 : 900 });
        },
      },
    });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    await vi.waitFor(() => expect(big.feed.between(T0 - 30 * DAY, T0)).toHaveLength(10));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    await quiet();
    const spans = rt.toolCalls('market.get_big_trades').map((c) => {
      const span = c.input as { from: number; to: number };
      return [span.from, span.to];
    });
    expect(spans).toEqual(Array.from({ length: 11 }, (_, k) => [ns(T0 - (k + 1) * DAY), ns(T0 - k * DAY)]));
    expect(open(T0 - 5.5 * DAY)).toBe(false);
    big.release();
    release();
  });

  it('reads no span past the clock while the tape is empty, after the walk has ended', async () => {
    const rt = fakeRuntime({ answers: { 'market.get_big_trades': () => bigTradesOutput() } });
    let now = T0;
    const hub = new FlowHub({ now: () => now }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    now = T0 + 5 * 60_000;
    flow.tradesChanged.emit();
    await quiet();
    expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20);
    big.release();
    release();
  });

  it('gives up after twice its ten days to load in calendar days when no day has prints', async () => {
    const rt = fakeRuntime({ answers: { 'market.get_big_trades': () => bigTradesOutput() } });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    await quiet();
    expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20);
    expect((rt.toolCalls('market.get_big_trades').at(-1)!.input as { from: number }).from).toBe(ns(T0 - 20 * DAY));
    big.release();
    release();
  });

  it('stops reading what the runtime refuses and says why, where any other failure is read again', async () => {
    const refusal = 'ESZ6 has no big trades';
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    (await vi.waitFor(() => rt.pending('market.get_big_trades'))).fail('invalid_input', refusal);
    await vi.waitFor(() => expect(big.feed.status).toEqual({ reading: false, error: refusal }));
    await readsAgain(1);
    flow.tradesChanged.emit();
    await quiet();
    expect(rt.toolCalls('market.get_big_trades')).toHaveLength(1);
    expect(big.feed.status).toEqual({ reading: false, error: refusal });
    big.release();
    const band = bigTrades(flow, size(5));
    (await vi.waitFor(() => rt.pending('market.get_big_trades'))).fail('internal', 'the tick store is busy');
    await vi.waitFor(() => expect(band.feed.status.error).toBe('the tick store is busy'));
    await readsAgain(1);
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(3));
    band.release();
    release();
  });

  it('words a bubble with no tier by its size alone, read back or live under the newest span’s cuts', async () => {
    const liveStart = T0 + 60_000;
    const untiered: BigTrade = {
      t: ns(T0 - 120_000),
      durationNs: 0,
      side: 'buy',
      size: 9,
      price: 5800,
      firstPrice: 5800,
      lastPrice: 5800,
      levels: 1,
      rangeTicks: 0,
      prints: 1,
      orders: 1,
      tier: null,
      outcome: null,
      seq: null,
    };
    const rt = fakeRuntime({
      answers: {
        'market.get_big_trades': (input) => {
          const scored = bigTradesOutput().rule;
          const cuts = (input as { to: number }).to === ns(liveStart) ? scored.cuts : null;
          const found = within([untiered], input);
          return bigTradesOutput({ rule: { ...scored, cuts }, trades: found, count: found.length });
        },
      },
    });
    const hub = new FlowHub({ now: () => liveStart }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const manual = bigTrades(flow, size(5));
    const rows = (feed: typeof manual.feed, from: number, to: number) =>
      bubbleTipCards(
        feed.between(from, to).map((trade) => ({ x: 0, y: 0, r: 8, opacity: 0.4, trade })),
        2,
      ).map((c) => [...c.headline, ...c.detail.slice(1)]);
    await vi.waitFor(() => expect(rt.toolCalls('market.get_big_trades')).toHaveLength(20));
    await vi.waitFor(() => expect(manual.feed.status.reading).toBe(false));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    sub.event(trades(0, [[ns(liveStart + 1000), 5800, 6, 1]]), 0);
    await vi.waitFor(() => expect(manual.feed.between(liveStart, liveStart + 5000)).toHaveLength(1));
    expect(rows(manual.feed, liveStart, liveStart + 5000), 'under the Low cut the newest day has').toEqual([
      [expect.stringMatching(/ 6 @ /), '1 fill'],
    ]);
    expect(rows(manual.feed, T0 - 3_600_000, T0), 'a read-back bubble the runtime left untiered').toEqual([
      [expect.stringMatching(/ 9 @ /), '1 fill'],
    ]);
    manual.release();
    release();
  });

  it('never shows a trade of unknown side, read back or live, and never as a sell', async () => {
    const liveStart = T0 + 60_000;
    const wire = (side: BigTrade['side'], size: number, t: number): BigTrade => ({
      t: ns(t),
      durationNs: 0,
      side,
      size,
      price: 5800,
      firstPrice: 5800,
      lastPrice: 5800,
      levels: 1,
      rangeTicks: 0,
      prints: 1,
      orders: 1,
      tier: null,
      outcome: null,
      seq: null,
    });
    const read = [wire('unknown', 500, T0 - 120_000), wire('sell', 40, T0 - 60_000)];
    const rt = fakeRuntime({
      answers: {
        'market.get_big_trades': (input) => {
          const found = within(read, input);
          const rule = { ...bigTradesOutput().rule, mode: 'manual' as const, tiers: null, minSize: 5, maxSize: null };
          return bigTradesOutput({ rule, trades: found, count: found.length });
        },
      },
    });
    const hub = new FlowHub({ now: () => liveStart }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const manual = bigTrades(flow, size(5));
    await vi.waitFor(() => expect(manual.feed.status.reading).toBe(false));
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    sub.event(
      trades(0, [
        [ns(liveStart + 1000), 5800, 600, 0],
        [ns(liveStart + 2000), 5799.75, 6, -1],
      ]),
      0,
    );
    await vi.waitFor(() => expect(manual.feed.between(liveStart, liveStart + 5000)).toHaveLength(1));
    expect(manual.feed.between(T0 - 3_600_000, liveStart + 5000).map((t) => [t.side, t.size])).toEqual([
      [-1, 40],
      [-1, 6],
    ]);
    manual.release();
    release();
  });

  it('draws a span the runtime is still filling at once, then replaces its events with the settled answer in one change', async () => {
    const big = (t: number, size: number, tier: 'high' | null) => ({
      t: ns(t),
      durationNs: 0,
      side: 'buy' as const,
      size,
      price: 5800,
      firstPrice: 5800,
      lastPrice: 5800,
      levels: 1,
      rangeTicks: 0,
      prints: 1,
      orders: 1,
      tier,
      outcome: null,
      seq: null,
    });
    const sizing = { ...bigTradesOutput().rule, cuts: null, modelOrders: 0, modelSessions: 0, modelMinutes: 0 };
    const hole = { from: ns(T0 - 600_000), to: ns(T0 - 300_000) };
    const newest = [
      bigTradesOutput({
        trades: [big(T0 - 120_000, 60, null)],
        count: 1,
        gaps: [hole],
        filling: true,
        rule: sizing,
      }),
      bigTradesOutput({ trades: [big(T0 - 120_000, 61, null)], count: 1, gaps: [hole], filling: true, rule: sizing }),
      bigTradesOutput({
        trades: [big(T0 - 400_000, 9, null), big(T0 - 120_000, 60, 'high')],
        count: 2,
        tiers: { high: 1, medium: 0, low: 0 },
      }),
    ];
    const rt = fakeRuntime({
      answers: {
        'market.get_big_trades': (input) =>
          Number(input.to) === ns(T0 + 60_000) ? (newest.shift() ?? bigTradesOutput()) : bigTradesOutput(),
      },
    });
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const use = bigTrades(flow, size(5));
    const feed = use.feed;
    const shown = () => feed.between(T0 - 3_600_000, T0).map((t) => [t.size, t.tier]);
    await vi.waitFor(() => expect(shown()).toEqual([[60, null]]));
    expect(feed.sizing, 'a filling answer’s rule is taken too').toBe(true);
    expect(feed.status).toEqual({ reading: false, error: null });
    expect(feed.gaps, 'a gap the runtime is filling is not marked').toEqual([]);
    const changes: (readonly (number | BigTradeTier | null | undefined)[][])[] = [];
    feed.changed.on(() => changes.push(shown()));
    const newestReads = () =>
      rt.toolCalls('market.get_big_trades').filter((c) => (c.input as { to: number }).to === ns(T0 + 60_000));
    await readsAgain(1);
    await vi.waitFor(() => expect(newestReads()).toHaveLength(2));
    await quiet();
    expect(shown(), 'an answer still filling is not applied').toEqual([[60, null]]);
    changes.length = 0;
    await readsAgain(2);
    await vi.waitFor(() => expect(newestReads()).toHaveLength(3));
    await vi.waitFor(() =>
      expect(shown()).toEqual([
        [9, null],
        [60, 'high'],
      ]),
    );
    expect(changes, 'the settled span lands in one change').toEqual([
      [
        [9, null],
        [60, 'high'],
      ],
    ]);
    expect(feed.cutFor('low')).toBe(8);
    expect(feed.cutFor('high')).toBe(30);
    expect(feed.gaps).toEqual([]);
    expect(newestReads().map((c) => c.input)).toEqual([0, 1, 2].map(() => newestReads()[0]!.input));
    await readsAgain(3);
    expect(newestReads()).toHaveLength(3);
    use.release();
    release();
  });

  it('words a sliced order’s bubble as one player: its size in fills, first to last price and duration and tier', async () => {
    const sliced: BigTrade = {
      t: ns(T0 - 120_000),
      durationNs: 1_200_000_000,
      side: 'buy',
      size: 492,
      price: 20_635.5,
      firstPrice: 20_627.75,
      lastPrice: 20_643,
      levels: 9,
      rangeTicks: 61,
      prints: 18,
      orders: 1,
      tier: 'high',
      outcome: null,
      seq: null,
    };
    const fought: BigTrade = {
      ...sliced,
      t: ns(T0 - 119_900),
      durationNs: 40_000_000,
      side: 'sell',
      size: 60,
      price: 20_640,
      firstPrice: 20_640,
      lastPrice: 20_640,
      levels: 1,
      rangeTicks: 0,
      prints: 3,
      tier: 'low',
    };
    fakeRuntime({
      answers: {
        'market.get_big_trades': (input) => {
          const trades = within([sliced, fought], input);
          return bigTradesOutput({ trades, count: trades.length, orders: trades.length });
        },
      },
    });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('NQ', 0.25, 2);
    const big = bigTrades(flow, size(5));
    await vi.waitFor(() => expect(big.feed.between(T0 - 3_600_000, T0)).toHaveLength(2));
    const markers = big.feed.between(T0 - 3_600_000, T0).map((trade) => ({ x: 0, y: 0, r: 8, opacity: 0.4, trade }));
    expect(bubbleTipCards(markers, 2).map((c) => [c.headline, c.detail.slice(1)])).toEqual([
      [
        ['Buy 492 @ 20,627.75–20,643.00', '9 levels'],
        ['18 fills in 1.2 s', 'High tier'],
      ],
      [['Sell 60 @ 20,640.00'], ['3 fills in 40 ms', 'Low tier']],
    ]);
    big.release();
    release();
  });

  it('lets a history read go when the chart does: its answer never reaches the bubbles', async () => {
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 + 60_000 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    const feed = big.feed;
    const changed = vi.fn();
    feed.changed.on(changed);
    const read = await vi.waitFor(() => rt.pending('market.get_big_trades'));
    expect(feed.status).toEqual({ reading: true, error: null });
    changed.mockClear();
    big.release();
    read.ok(bigTradesOutput({ gaps: [{ from: ns(T0 - 600_000), to: ns(T0) }], filling: true }));
    await quiet();
    expect(feed.gaps).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    await readsAgain(1);
    expect(rt.toolCalls('market.get_big_trades')).toHaveLength(1);
    release();
  });
});

describe('one big-trades feed per grouping, filtered on the desk', () => {
  const wire = (t: number, lots: number, tier: BigTradeTier | null): BigTrade => ({
    t: ns(t),
    durationNs: 0,
    side: 'buy',
    size: lots,
    price: 5800,
    firstPrice: 5800,
    lastPrice: 5800,
    levels: 1,
    rangeTicks: 0,
    prints: 1,
    orders: 1,
    tier,
    outcome: null,
    seq: null,
  });
  const held = [
    wire(T0 - 3 * DAY - 60_000, 6, null),
    wire(T0 - DAY - 60_000, 12, 'low'),
    wire(T0 - 120_000, 40, 'high'),
  ];
  type Ask = { from: number; to: number; minSize: number; maxSize?: number };
  const serving = (cuts: { low: number; medium: number; high: number }, autoSize: number | null = 16) =>
    fakeRuntime({
      answers: {
        ...(autoSize === null ? {} : { 'market.get_trades': () => threshold(autoSize) }),
        'market.get_big_trades': (input) => {
          const ask = input as Ask;
          const trades = within(held, input).filter(
            (t) => t.size >= ask.minSize && (ask.maxSize === undefined || t.size <= ask.maxSize),
          );
          return bigTradesOutput({
            rule: { ...bigTradesOutput().rule, cuts },
            trades,
            count: trades.length,
            orders: 900,
          });
        },
      },
    });
  const reads = (rt: FakeRuntime) => rt.toolCalls('market.get_big_trades').map((c) => c.input as Ask);
  const lots = (b: ReturnType<typeof bigTrades>) => b.view.between(T0 - 30 * DAY, T0).map((t) => t.size);
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const tenSessions = Array.from({ length: 10 }, (_, k) => [ns(T0 - (k + 1) * DAY), ns(T0 - k * DAY)]);

  it('reads nothing when the size goes up or switches between Auto and a size the floor holds, and keeps the events', async () => {
    const rt = serving({ low: 12, medium: 20, high: 40 });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(10));
    await vi.waitFor(() => expect(reads(rt)).toHaveLength(10));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    expect(lots(big)).toEqual([12, 40]);
    const first = big.view.between(T0 - 30 * DAY, T0);
    big.set(size(20));
    expect(lots(big)).toEqual([40]);
    big.set(AUTO);
    await vi.waitFor(() => expect(flow.threshold?.size).toBe(16));
    expect(lots(big), 'the tiered events').toEqual([12, 40]);
    big.set(byTier('medium'));
    expect(lots(big), 'Medium drops the Low event').toEqual([40]);
    big.set(byTier('high'));
    expect(lots(big)).toEqual([40]);
    big.set(AUTO);
    big.set(size(10));
    expect(big.view.between(T0 - 30 * DAY, T0), 'the very array the chart drew').toBe(first);
    await elapse(LOWER_AFTER_MS);
    expect(reads(rt)).toHaveLength(10);
    expect(big.feed.floor).toBe(10);
    big.release();
    release();
  });

  it('reads only the sizes it lacks when the size goes below the floor: bands under the old floor over the spans read', async () => {
    const rt = serving({ low: 12, medium: 20, high: 40 });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(10));
    await vi.waitFor(() => expect(reads(rt)).toHaveLength(10));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    const atFive: boolean[] = [];
    const atTen: boolean[] = [];
    const off = big.feed.changed.on(() => {
      atFive.push(big.feed.statusFor(size(5)).reading);
      atTen.push(big.feed.statusFor(size(10)).reading);
    });
    big.set(size(5));
    expect(lots(big), 'what it holds stays on the chart').toEqual([12, 40]);
    expect(big.feed.statusFor(size(5)).reading, 'nothing reads while the size may still be typed').toBe(false);
    await vi.waitFor(() => expect(lots(big)).toEqual([6, 12, 40]));
    await quiet();
    off();
    expect(atFive, 'a size under every span read reads until its first answer').toContain(true);
    expect(atFive.at(-1)).toBe(false);
    expect(atTen, 'a chart at 10 holds all it shows').not.toContain(true);
    await quiet();
    const bands = reads(rt).slice(10);
    expect(bands.map((r) => [r.minSize, r.maxSize])).toEqual(tenSessions.map(() => [5, 9]));
    expect(bands.map((r) => [r.from, r.to])).toEqual(tenSessions);
    expect(big.feed.floor).toBe(5);
    big.release();
    release();
  });

  it('reads nothing while the size is typed: 6 on the way to 60', async () => {
    const rt = serving({ low: 12, medium: 20, high: 40 });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(10));
    await vi.waitFor(() => expect(reads(rt)).toHaveLength(10));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    big.set(size(6));
    await elapse(LOWER_AFTER_MS - 1);
    big.set(size(60));
    await elapse(LOWER_AFTER_MS);
    expect(reads(rt)).toHaveLength(10);
    expect(big.feed.floor).toBe(10);
    expect(lots(big)).toEqual([]);
    big.release();
    release();
  });

  it('serves two charts of one grouping from one feed, each with its own size', async () => {
    const rt = serving({ low: 12, medium: 20, high: 40 });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const wide = bigTrades(flow, size(30));
    const narrow = bigTrades(flow, size(10));
    expect(narrow.feed).toBe(wide.feed);
    await vi.waitFor(() => expect(lots(narrow)).toEqual([12, 40]));
    await vi.waitFor(() => expect(wide.feed.status.reading).toBe(false));
    expect(lots(wide)).toEqual([40]);
    expect(rt.subscriptions.filter((x) => x.topic === 'market.trades')).toHaveLength(1);
    expect(reads(rt).every((r) => r.minSize === 10 || r.minSize === 30)).toBe(true);
    for (const b of [wide, narrow]) b.release();
    release();
  });

  it('starts Auto once Tessera’s size now is in, reading from three quarters of it, and scales to the answer’s cut for its tier', async () => {
    const rt = serving({ low: 32, medium: 50, high: 80 }, null);
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, AUTO);
    const sized = await vi.waitFor(() => rt.pending('market.get_trades'));
    await quiet();
    expect(reads(rt)).toEqual([]);
    expect(big.view.reference()).toBeNaN();
    sized.ok(threshold(40));
    await vi.waitFor(() => expect(reads(rt).length).toBeGreaterThan(0));
    expect(reads(rt)[0]).toMatchObject({ minSize: 30 });
    expect('maxSize' in reads(rt)[0]!).toBe(false);
    await vi.waitFor(() => expect(big.view.reference()).toBe(32));
    expect(new BigTradeView(big.feed, size(25, 300)).reference()).toBe(25);
    expect(new BigTradeView(big.feed, byTier('medium')).reference()).toBe(50);
    expect(new BigTradeView(big.feed, byTier('high')).reference()).toBe(80);
    expect(big.feed.statusFor(byTier('high')).reading).toBe(false);
    big.release();
    release();
  });

  it('widens Auto’s floor to an answer’s Low cut under it', async () => {
    const rt = serving({ low: 12, medium: 20, high: 40 }, 40);
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, AUTO);
    await vi.waitFor(() => expect(lots(big)).toEqual([12, 40]));
    await vi.waitFor(() => expect(big.feed.status.reading).toBe(false));
    expect(big.feed.floor).toBe(12);
    const asked = reads(rt);
    expect(asked[0]).toMatchObject({ minSize: 30 });
    expect(asked.filter((r) => r.maxSize !== undefined).map((r) => [r.minSize, r.maxSize, r.from, r.to])).toEqual([
      [12, 29, ...tenSessions[0]!],
    ]);
    expect(asked.slice(1).every((r) => r.minSize === 12)).toBe(true);
    big.release();
    release();
  });
});

describe('where the order flow has no prints', () => {
  const session = (gaps: ProfileOutput['gaps'], rows: ProfileOutput['rows'] = []): ProfileOutput => ({
    from: ns(T0 - 3_600_000),
    to: ns(T0),
    sessionEnd: ns(T0 + 3_600_000),
    tradeDate: '2026-10-02',
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
    gaps,
    rows,
  });
  const hole = { from: ns(T0 - 3_600_000), to: ns(T0 - 600_000) };

  it('marks no gap from a footprint answer the runtime is still filling, and none once the fill has closed it', async () => {
    const gap = { from: ns(T0 - 120_000), to: ns(T0 - 60_000) };
    const answers = [
      footprintOutput([fpBar(T0, [[5800, 1, 2]])], { lastBarOpen: true, truncated: false, gaps: [gap], filling: true }),
      footprintOutput(
        [fpBar(T0 - 120_000, [[5800, 1, 1]]), fpBar(T0 - 60_000, [[5800, 2, 1]]), fpBar(T0, [[5800, 1, 2]])],
        {
          lastBarOpen: true,
          truncated: false,
        },
      ),
    ];
    const rt = fakeRuntime({ answers: { 'market.get_footprint': () => answers.shift() ?? answers.at(-1)! } });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    const marked: (readonly { from: number; to: number }[])[] = [];
    footprints.feed.changed.on(() => marked.push(footprints.feed.gaps));
    await vi.waitFor(() => expect(footprints.feed.store.length).toBe(1));
    expect(footprints.feed.gaps).toEqual([]);
    await readsAgain(1);
    await vi.waitFor(() => expect(footprints.feed.store.length).toBe(3));
    expect(rt.toolCalls('market.get_footprint')).toHaveLength(2);
    expect(marked.flat(), 'the gap is never marked while the runtime replays it').toEqual([]);
    footprints.release();
    release();
  });

  it('marks the gap the runtime could not fill once its answer settles', async () => {
    const gap = { from: ns(T0 - 120_000), to: ns(T0 - 60_000) };
    const answers = [
      footprintOutput([fpBar(T0, [[5800, 1, 2]])], { lastBarOpen: true, truncated: false, gaps: [gap], filling: true }),
      footprintOutput([fpBar(T0, [[5800, 1, 2]])], { lastBarOpen: true, truncated: false, gaps: [gap] }),
    ];
    fakeRuntime({ answers: { 'market.get_footprint': () => answers.shift() ?? answers.at(-1)! } });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const footprints = flow.useFootprints('1m');
    await vi.waitFor(() => expect(footprints.feed.store.length).toBe(1));
    expect(footprints.feed.gaps).toEqual([]);
    await readsAgain(1);
    await vi.waitFor(() => expect(footprints.feed.gaps).toEqual([{ from: T0 - 120_000, to: T0 - 60_000 }]));
    footprints.release();
    release();
  });

  it('keeps the gaps the big trades and the session profiles answer, in ms, for the gap mark', async () => {
    fakeRuntime({
      answers: {
        'market.get_big_trades': (input) =>
          bigTradesOutput({ gaps: [{ from: Number(input.from), to: Number(input.from) + ns(3_600_000) }] }),
        'market.get_volume_profile': () => volumeProfile([session([hole])]),
      },
    });
    const hub = new FlowHub({ now: () => T0 }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const big = bigTrades(flow, size(5));
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    await vi.waitFor(() => expect(big.feed.gaps).toHaveLength(20));
    expect(big.feed.gaps[0]).toEqual({ from: T0 - 20 * DAY, to: T0 - 20 * DAY + 3_600_000 });
    expect(big.feed.gaps.at(-1)).toEqual({ from: T0 - DAY, to: T0 - DAY + 3_600_000 });
    await vi.waitFor(() => expect(vp.feed.periods('session')).toHaveLength(1));
    expect(vp.feed.gaps).toEqual([{ from: T0 - 3_600_000, to: T0 - 600_000 }]);
    expect(vp.feed.periods('session')[0]!.partial).toBe(true);
    big.release();
    vp.release();
    release();
  });

  it('holds a session profile with gaps back while its answer is filling, then draws it from its stored prints, partial', async () => {
    const answers = [
      volumeProfile([session([hole], [[5800, 4, 2, 2]])], true),
      volumeProfile([session([hole], [[5800, 6, 3, 3]])], false),
    ];
    const rt = fakeRuntime({
      answers: { 'market.get_volume_profile': () => answers.shift() ?? volumeProfile([session([hole])]) },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(1));
    await quiet();
    expect(vp.feed.periods('session'), 'a session with gaps waits while the fill may complete it').toEqual([]);
    expect(vp.feed.status).toEqual({ reading: false, error: null });
    expect(vp.feed.gaps).toEqual([]);
    await readsAgain(1);
    await vi.waitFor(() => expect(vp.feed.periods('session')).toHaveLength(1));
    const drawn = vp.feed.periods('session')[0]!;
    expect([...drawn.volume]).toEqual([6]);
    expect(drawn.partial).toBe(true);
    expect(vp.feed.gaps).toEqual([{ from: T0 - 3_600_000, to: T0 - 600_000 }]);
    expect(rt.toolCalls('market.get_volume_profile').map((c) => c.input)).toEqual([
      rt.toolCalls('market.get_volume_profile')[0]!.input,
      rt.toolCalls('market.get_volume_profile')[0]!.input,
    ]);
    vp.release();
    release();
  });

  it('asks a filling question again once however often it is answered, and stops with the feed', async () => {
    const running = new Lifetime();
    const refill = new Refill(running);
    const asked: number[] = [];
    let filling = true;
    const question = () => {
      asked.push(asked.length);
      return Promise.resolve({ filling });
    };
    const settled = vi.fn();
    refill.ask('newest', question, settled);
    refill.ask('newest', question, settled);
    await readsAgain(1);
    expect(asked, 'one refill per question').toHaveLength(1);
    await readsAgain(2);
    expect(asked).toHaveLength(2);
    expect(settled).not.toHaveBeenCalled();
    filling = false;
    await readsAgain(3);
    expect(asked).toHaveLength(3);
    expect(settled).toHaveBeenCalledTimes(1);
    refill.ask('newest', question, settled);
    filling = true;
    await readsAgain(1);
    expect(asked).toHaveLength(4);
    running.end();
    await readsAgain(2);
    await readsAgain(3);
    expect(asked, 'nothing is asked once the feed is gone').toHaveLength(4);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe('session profiles', () => {
  const profile = (rows: [number, number, number, number][]): ProfileOutput => ({
    from: ns(T0 - 3_600_000),
    to: ns(T0 + 3_600_000),
    sessionEnd: ns(T0 + 3_600_000),
    tradeDate: '2026-10-02',
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
    gaps: [],
    rows,
  });

  it('reads the sessions a view scrolls back to past the newest ten, once each, and stops at a refusal until the view asks for older', async () => {
    const DAY = 86_400_000;
    const opens = Array.from({ length: 15 }, (_, k) => T0 - (14 - k) * DAY - 3_600_000);
    const day = (k: number): ProfileOutput => ({
      ...profile([[5800, 10, 6, 4]]),
      from: ns(opens[k]!),
      to: ns(opens[k]! + 23 * 3_600_000),
      sessionEnd: ns(opens[k]! + 23 * 3_600_000),
      tradeDate: null,
    });
    const rt = fakeRuntime();
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    const reads = () => rt.toolCalls('market.get_volume_profile').length;
    const newest = await vi.waitFor(() => rt.pending('market.get_volume_profile'));
    expect(newest.input).toMatchObject({ sessions: 10 });
    expect(newest.input).not.toHaveProperty('to');
    newest.ok(volumeProfile(opens.slice(5).map((_, j) => day(5 + j))));
    await vi.waitFor(() => expect(vp.feed.periods('session')).toHaveLength(10));

    let wanted = opens[2]! + 600_000;
    vp.feed.changed.on(() => vp.feed.ensureFrom('session', wanted, Infinity));
    vp.feed.ensureFrom('session', wanted, Infinity);
    const older = await vi.waitFor(() => rt.pending('market.get_volume_profile'));
    expect(older.input).toMatchObject({ sessions: 3, to: msToNs(opens[5]! - 1) });
    expect(vp.feed.status.reading, 'reading older sessions is not a first read').toBe(false);
    older.ok(volumeProfile([2, 3, 4].map(day)));
    await vi.waitFor(() => expect(vp.feed.periods('session').map((x) => x.from)).toEqual(opens.slice(2)));
    await quiet();
    expect(reads()).toBe(2);

    wanted = opens[0]!;
    vp.feed.ensureFrom('session', wanted, Infinity);
    (await vi.waitFor(() => rt.pending('market.get_volume_profile'))).fail('unsupported', 'no older sessions here');
    await vi.waitFor(() => expect(vp.feed.status.error).not.toBeNull());
    await quiet();
    expect(reads()).toBe(3);

    wanted = opens[0]! - DAY;
    vp.feed.ensureFrom('session', wanted, Infinity);
    const again = await vi.waitFor(() => rt.pending('market.get_volume_profile'));
    expect(again.input).toMatchObject({ to: msToNs(opens[2]! - 1) });
    again.ok(volumeProfile([0, 1].map(day)));
    (await vi.waitFor(() => rt.pending('market.get_volume_profile'))).ok(volumeProfile([]));
    await vi.waitFor(() => expect(vp.feed.status).toEqual({ reading: false, error: null }));
    expect(vp.feed.periods('session').map((x) => x.from)).toEqual(opens);
    await quiet();
    expect(reads()).toBe(5);
    vp.release();
    release();
  });

  it('draws a session with gaps the runtime is still filling only once its answer settles, whole, in one change', async () => {
    const yesterday: ProfileOutput = {
      ...profile([[5799, 40, 20, 20]]),
      from: ns(T0 - DAY - 3_600_000),
      to: ns(T0 - DAY + 3_600_000),
      sessionEnd: ns(T0 - DAY + 3_600_000),
      tradeDate: '2026-10-01',
    };
    const today = (rows: [number, number, number, number][], knownFrom: number | null): ProfileOutput => ({
      ...profile(rows),
      gaps: knownFrom === null ? [] : [{ from: ns(T0 - 3_600_000), to: ns(knownFrom) }],
    });
    const rows: [number, number, number, number][] = [
      [5800, 10, 6, 4],
      [5800.25, 30, 20, 10],
      [5800.5, 5, 1, 4],
    ];
    const answers = [
      volumeProfile([yesterday, today(rows.slice(2), T0 - 600_000)], true),
      volumeProfile([today(rows.slice(1), T0 - 1_800_000)], true),
      volumeProfile([today(rows, null)], false),
    ];
    const rt = fakeRuntime({
      answers: { 'market.get_volume_profile': () => answers.shift() ?? volumeProfile([yesterday]) },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    const seen: { sessions: readonly SessionProfileData[] }[] = [];
    vp.feed.changed.on(() => seen.push({ sessions: vp.feed.periods('session') }));
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(1));
    await quiet();
    const drawnFirst = vp.feed.periods('session');
    expect(
      drawnFirst.map((s) => s.from),
      'the whole older session is drawn at once',
    ).toEqual([T0 - DAY - 3_600_000]);
    expect(vp.feed.status).toEqual({ reading: false, error: null });
    await readsAgain(1);
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(2));
    await quiet();
    expect(vp.feed.periods('session'), 'an answer still filling draws nothing new').toBe(drawnFirst);
    await readsAgain(2);
    await vi.waitFor(() => expect(vp.feed.periods('session')).toHaveLength(2));
    const shown = seen.map((x) => x.sessions.find((s) => s.from === T0 - 3_600_000)).filter((s) => s !== undefined);
    expect(
      shown.map((s) => [...s.volume]),
      'today never shows partial rows',
    ).toEqual(shown.map(() => [10, 30, 5]));
    expect(shown.every((s) => s.partial === false)).toBe(true);
    expect(vp.feed.gaps).toEqual([]);
    await readsAgain(3);
    expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(3);
    vp.release();
    release();
  });

  it('reads a Market Profile through the same engine, keeping its brackets apart from the volume profile', async () => {
    const tpo = {
      minutes: 30,
      brackets: [
        [ns(T0 - 3_600_000), 0, 5800, 5801.5],
        [ns(T0 - 1_800_000), 1, 5801, 5802],
      ] as [number, number, number, number][],
      poc: 5801,
      vah: 5801.5,
      val: 5800.75,
      ibFrom: ns(T0 - 3_600_000),
      ibHigh: 5802,
      ibLow: 5800,
    };
    const rt = fakeRuntime({
      answers: {
        'market.get_volume_profile': (input) =>
          volumeProfile([
            { ...profile([[5800, 10, 6, 4]]), ...((input as { tpoMinutes?: number }).tpoMinutes ? { tpo } : {}) },
          ]),
      },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    vp.feed.periods('session', 'all', 30);
    await vi.waitFor(() => expect(vp.feed.periods('session', 'all', 30)[0]?.tpo).toBeTruthy());
    expect(vp.feed.periods('session', 'all', 30)[0]!.tpo).toEqual({
      minutes: 30,
      brackets: [
        { start: T0 - 3_600_000, letter: 0, lowTick: 23200, highTick: 23206 },
        { start: T0 - 1_800_000, letter: 1, lowTick: 23204, highTick: 23208 },
      ],
      ibFrom: T0 - 3_600_000,
      ibLowTick: 23200,
      ibHighTick: 23208,
    });
    await vi.waitFor(() => expect(vp.feed.periods('session')).toHaveLength(1));
    expect(vp.feed.periods('session')[0]!.tpo).toBeNull();
    const asked = rt.toolCalls('market.get_volume_profile').map((c) => c.input as { tpoMinutes?: number });
    expect(asked.filter((i) => i.tpoMinutes === 30).length).toBeGreaterThan(0);
    expect(asked.filter((i) => i.tpoMinutes === undefined).length).toBeGreaterThan(0);
    vp.release();
    release();
  });

  it('reads weekly profiles for a weekly layer, with the week and prior week levels, and composites of weeks', async () => {
    const rt = fakeRuntime({
      answers: {
        'market.get_volume_profile': (input) =>
          input.mode === 'composite'
            ? { ...volumeProfile([profile([[5810, 30, 20, 10]])]), mode: 'composite' as const, period: 'week' as const }
            : { ...volumeProfile([profile([[5800, 10, 6, 4]])]), mode: 'week' as const, period: 'week' as const },
      },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const week = flow.useProfiles();
    const session = flow.useProfiles();
    expect(week.feed, 'one profile engine per instrument').toBe(session.feed);
    await vi.waitFor(() => expect(week.feed.periods('week')).toHaveLength(1));
    const weekly = rt.toolCalls('market.get_volume_profile').map((c) => c.input as { mode: string });
    expect(weekly.filter((i) => i.mode === 'week').length).toBeGreaterThan(0);
    expect(week.feed.periods('week')[0]!.label).toBe('Wk Oct 2');
    const level = (field: string, price: number): Level => ({
      key: `tessera.concepts.${field}`,
      instrument: 'ESZ6.CME',
      label: field,
      short: null,
      group: 'vp',
      price,
      unavailableReason: null,
      nativePrice: null,
      source: {
        vendor: 'Tessera',
        package: 'Concepts',
        field,
        basis: 'ES',
        endpoint: null,
        asOf: ns(T0),
        conversion: null,
      },
      concept: null,
    });
    week.feed.setLevels([level('wpoc', 5801), level('wvah', 5802), level('wval', 5799), level('poc', 1)]);
    expect(week.feed.periods('week')[0]!.levels).toEqual({ poc: 5801, vah: 5802, val: 5799 });
    expect(week.feed.composite(3, 'week', 'all')).toBeNull();
    await vi.waitFor(() => expect(week.feed.composite(3, 'week', 'all')?.volume[0]).toBe(30));
    const composite = rt
      .toolCalls('market.get_volume_profile')
      .map((c) => c.input as { mode: string; period?: string; count?: number })
      .find((i) => i.mode === 'composite');
    expect(composite).toMatchObject({ period: 'week', count: 3 });
    week.release();
    session.release();
    release();
  });

  it('measures a regular-hours composite from the regular-hours prints alone, apart from the all-hours one', async () => {
    const rt = fakeRuntime({
      answers: {
        'market.get_volume_profile': (input) =>
          input.mode !== 'composite'
            ? volumeProfile([])
            : {
                ...volumeProfile([profile([[5800, input.session === 'rth' ? 17_800_000 : 24_700_000, 0, 0]])]),
                mode: 'composite',
              },
      },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    await vi.waitFor(() => expect(vp.feed.status.reading).toBe(false));
    const cvah = (field: string, price: number): Level => ({
      key: `tessera.concepts.${field}`,
      instrument: 'ESZ6.CME',
      label: field,
      short: null,
      group: 'vp',
      price,
      unavailableReason: null,
      nativePrice: null,
      source: {
        vendor: 'Tessera',
        package: 'Concepts',
        field,
        basis: 'ES',
        endpoint: null,
        asOf: ns(T0),
        conversion: null,
      },
      concept: null,
    });
    vp.feed.setLevels([cvah('cpoc', 5801), cvah('cvah', 5802), cvah('cval', 5799)]);
    vp.feed.composite(5, 'session', 'rth');
    vp.feed.composite(5, 'session', 'all');
    await vi.waitFor(() => expect(vp.feed.composite(5, 'session', 'rth')?.volume[0]).toBe(17_800_000));
    await vi.waitFor(() => expect(vp.feed.composite(5, 'session', 'all')?.volume[0]).toBe(24_700_000));
    const asked = rt
      .toolCalls('market.get_volume_profile')
      .map((c) => c.input as { mode: string; session?: string })
      .filter((i) => i.mode === 'composite');
    expect(asked.map((i) => i.session ?? 'all').sort()).toEqual(['all', 'rth']);
    expect(
      vp.feed.composite(5, 'session', 'all')?.levels,
      'the all-hours composite keeps the concept’s levels',
    ).toEqual({
      poc: 5801,
      vah: 5802,
      val: 5799,
    });
    expect(vp.feed.composite(5, 'session', 'rth')?.levels, 'which measure every hour, so not the RTH one').toBeNull();
    vp.release();
    release();
  });

  it('draws a composite the runtime is still filling at once, then the settled one', async () => {
    const answers = [
      { ...volumeProfile([profile([[5800, 10, 6, 4]])], true), mode: 'composite' as const },
      { ...volumeProfile([profile([[5800, 12, 6, 6]])], false), mode: 'composite' as const },
    ];
    const rt = fakeRuntime({
      answers: {
        'market.get_volume_profile': (input) =>
          (input.mode === 'composite' ? answers.shift() : null) ?? volumeProfile([]),
      },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.periods('session');
    await vi.waitFor(() => expect(vp.feed.status.reading).toBe(false));
    expect(vp.feed.composite(5, 'session', 'all')).toBeNull();
    await vi.waitFor(() => expect(vp.feed.composite(5, 'session', 'all')?.volume[0]).toBe(10));
    await readsAgain(1);
    await vi.waitFor(() => expect(vp.feed.composite(5, 'session', 'all')?.volume[0]).toBe(12));
    expect(vp.feed.status.reading).toBe(false);
    expect(
      rt.toolCalls('market.get_volume_profile').filter((c) => (c.input as { mode: string }).mode === 'composite'),
    ).toHaveLength(2);
    vp.release();
    release();
  });

  it('lays a runtime profile out as dense rows and adds live prints without touching the read one', () => {
    const p = profileData(
      profile([
        [5800, 10, 6, 4],
        [5800.75, 3, 1, 2],
      ]),
      0.25,
    );
    expect(p.label).toBe('Fri');
    expect(p.rows).toBe(4);
    expect([...p.volume]).toEqual([10, 0, 0, 3]);
    const q = addPrints(p, [
      [23199, 2, 1],
      [23204, 5, -1],
    ]);
    expect(q.lowTick).toBe(23199);
    expect(q.rows).toBe(6);
    expect(q.volume[0]).toBe(2);
    expect(q.sell[5]).toBe(5);
    expect([...p.volume]).toEqual([10, 0, 0, 3]);
    expect(sessionLabel(null, Date.UTC(2026, 9, 1, 12))).toBe('Thu');
  });

  it('keeps the session trading now up from the prints after its read, to its scheduled end', async () => {
    const read: ProfileOutput = {
      ...profile([[5800, 10, 6, 4]]),
      to: ns(T0),
      sessionEnd: ns(T0 + 7_200_000),
      lastPrint: ns(T0 - 1000),
    };
    const rt = fakeRuntime({ answers: { 'market.get_volume_profile': () => volumeProfile([read]) } });
    const now = { t: T0 };
    const hub = new FlowHub({ now: () => now.t });
    const { flow, release: releaseFlow } = hub.acquire('ES', 0.25, 2);
    const { feed, release } = flow.useProfiles();
    feed.periods('session');
    await vi.waitFor(() => expect(feed.periods('session')).toHaveLength(1));
    expect(feed.periods('session').at(-1)!.to).toBe(T0 + 7_200_000);
    const sub = await vi.waitFor(() => rt.sub('market.trades'));
    sub.event(
      { instrument: 'ES', seq: 0, trades: [[ns(T0 - 1000), 5800, 10, 1]], aggressorSource: 'exchange', source },
      0,
    );
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(2));
    expect(rt.toolCalls('market.get_volume_profile')[1]!.input).toMatchObject({ mode: 'session', sessions: 1 });
    await quiet();
    now.t = T0 + 10_000;
    sub.event(
      {
        instrument: 'ES',
        seq: 2,
        trades: [
          [ns(T0 + 9_000), 5800.25, 3, 1],
          [ns(T0 + 9_500), 5800, 2, -1],
        ],
        aggressorSource: 'exchange',
        source,
      },
      1,
    );
    await vi.waitFor(() => expect([...feed.periods('session').at(-1)!.volume]).toEqual([12, 3]));
    const s = feed.periods('session').at(-1)!;
    expect(s.lowTick).toBe(23200);
    expect(s.sell[0]).toBe(6);
    sub.event(
      { instrument: 'ES', seq: 3, trades: [[ns(T0 + 7_200_000), 5801, 9, 1]], aggressorSource: 'exchange', source },
      2,
    );
    await vi.waitFor(() => expect(flow.tape.seq).toBe(3));
    expect(feed.periods('session').at(-1)!.rows).toBe(2);
    expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(2);
    release();
    releaseFlow();
  });
});

describe('one profile engine', () => {
  const ranged = (rows: [number, number, number, number][], filling = false) =>
    volumeProfile(
      [
        {
          from: ns(T0 - 3_600_000),
          to: ns(T0),
          sessionEnd: null,
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
          gaps: filling ? [{ from: ns(T0 - 3_600_000), to: ns(T0 - 1_800_000) }] : [],
          rows,
        },
      ],
      filling,
    );

  it('reads a closed range once, an anchored one again every few seconds while it is drawn, and forgets both after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const rt = fakeRuntime({ answers: { 'market.get_volume_profile': () => ranged([[5800, 4, 3, 1]]) } });
    const now = { t: T0 };
    const hub = new FlowHub({ now: () => now.t }, { keepMs: 0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    const from = T0 - 3 * 86_400_000;
    const closedTo = T0 - 2 * 86_400_000;
    vp.feed.span(from, closedTo, 'all');
    vp.feed.span(from, null, 'rth');
    await vi.waitFor(() => expect(rt.toolCalls('market.get_volume_profile')).toHaveLength(2));
    const asked = rt.toolCalls('market.get_volume_profile').map((c) => c.input);
    expect(asked).toEqual([
      {
        instrument: 'ES',
        mode: 'range',
        from: msToNs(from),
        to: msToNs(closedTo),
        rowTicks: 1,
        maxRows: 500,
        daysToLoad: 2,
      },
      { instrument: 'ES', mode: 'range', from: msToNs(from), session: 'rth', rowTicks: 1, maxRows: 500, daysToLoad: 2 },
    ]);
    await vi.waitFor(() => expect(vp.feed.span(from, closedTo, 'all')?.volume[0]).toBe(4));
    expect(vp.feed.span(from, null, 'rth')?.label).toBe('Fri');
    for (let k = 0; k < 3; k++) {
      now.t += OPEN_SPAN_REFRESH_MS;
      vp.feed.span(from, closedTo, 'all');
      vp.feed.span(from, null, 'rth');
      await vi.advanceTimersByTimeAsync(OPEN_SPAN_REFRESH_MS);
    }
    const reads = (to: boolean) =>
      rt.toolCalls('market.get_volume_profile').filter((c) => 'to' in (c.input as object) === to).length;
    expect(reads(true), 'a closed range is read once').toBe(1);
    expect(reads(false), 'an anchored one again every few seconds').toBeGreaterThanOrEqual(3);
    now.t += 10 * 60_000;
    await vi.advanceTimersByTimeAsync(OPEN_SPAN_REFRESH_MS);
    const before = rt.toolCalls('market.get_volume_profile').length;
    await vi.advanceTimersByTimeAsync(4 * OPEN_SPAN_REFRESH_MS);
    expect(rt.toolCalls('market.get_volume_profile'), 'nothing is read for a profile no longer drawn').toHaveLength(
      before,
    );
    vp.release();
    release();
  });

  it('reads a 13-week rolling composite in one call, and a range still filling again until it settles', async () => {
    const answers = [ranged([[5800, 2, 1, 1]], true), ranged([[5800, 9, 5, 4]])];
    const rt = fakeRuntime({
      answers: {
        'market.get_volume_profile': (input) =>
          input.mode === 'range' ? (answers.shift() ?? ranged([[5800, 9, 5, 4]])) : ranged([[5810, 30, 20, 10]]),
      },
    });
    const hub = new FlowHub({ now: () => T0 });
    const { flow, release } = hub.acquire('ES', 0.25, 2);
    const vp = flow.useProfiles();
    vp.feed.composite(13, 'week', 'all');
    await vi.waitFor(() => expect(vp.feed.composite(13, 'week', 'all')?.volume[0]).toBe(30));
    expect(rt.toolCalls('market.get_volume_profile').map((c) => c.input)).toEqual([
      { instrument: 'ES', mode: 'composite', period: 'week', count: 13, rowTicks: 1, maxRows: 500, daysToLoad: 2 },
    ]);
    const from = T0 - 3 * 86_400_000;
    vp.feed.span(from, T0 - 86_400_000, 'all');
    await vi.waitFor(() => expect(vp.feed.span(from, T0 - 86_400_000, 'all')?.volume[0]).toBe(2));
    await readsAgain(1);
    await vi.waitFor(() => expect(vp.feed.span(from, T0 - 86_400_000, 'all')?.volume[0]).toBe(9));
    expect(vp.feed.gaps).toEqual([]);
    vp.release();
    release();
  });
});

describe('order-flow legend and menus', () => {
  it('says reading while a stream has not answered, or says stopped, from the statuses a view reads', () => {
    const s = new FlowState();
    noteFrom(s, [{ reading: false, error: null }, null, { reading: true, error: null }]);
    expect(s.reading).toBe(true);
    expect(s.note).toBeNull();
    noteFrom(s, [
      { reading: true, error: null },
      { reading: false, error: 'Rithmic dropped' },
    ]);
    expect(s.note).toEqual({ text: 'stopped: Rithmic dropped' });
    expect(s.reading).toBe(false);
    noteFrom(s, [{ reading: false, error: 'tools.invoke: no response within 20000ms' }]);
    expect(s.note?.text).not.toMatch(/tools\.invoke/i);
    expect(s.note?.text).not.toMatch(/20000ms/i);
    expect(s.stopped).toBe(true);
    noteFrom(s, [{ reading: false, error: null }]);
    expect(s.note).toBeNull();
    expect(s.stopped).toBe(false);
    expect(s.reading).toBe(false);
  });

  it('says how many sessions of its days a study holds while it fills, and when the login refuses the rest', () => {
    const s = new FlowState();
    const loaded = (held: number, filling: boolean, refused = false) => ({
      reading: false,
      error: null,
      loaded: { loaded: { sessions: 2, held, refused }, filling },
    });
    noteFrom(s, [loaded(2, false), loaded(1, true)]);
    expect(s.notice?.text).toBe('Loading · 1 of 2 sessions');
    expect(s.note, 'the values still show beside it').toBeNull();
    noteFrom(s, [loaded(1, false, true)]);
    expect(s.notice?.text).toBe(OLDER_HISTORY_REFUSED);
    noteFrom(s, [loaded(2, false)]);
    expect(s.notice).toBeNull();
    noteFrom(s, [{ reading: false, error: 'Rithmic dropped' }, loaded(1, true)]);
    expect(s.notice, 'a stopped study says only that').toBeNull();
  });

  it('reads row sizes', () => {
    expect(rowTicksOf('auto')).toBe('auto');
    expect(rowTicksOf('4')).toBe(4);
  });

  it('words the analyst’s questions with the measured facts', () => {
    const bar: AskTarget = {
      kind: 'bar',
      label: 'this bar',
      from: T0,
      to: T0 + 60_000,
      low: 5810,
      high: 5814.5,
      detail: 'volume 4,100, delta +312',
    };
    expect(askLabel(bar)).toBe("Ask about the 14:42 bar's order flow");
    const q = askQuestion(bar, 'ES Z6', '1m', (p) => p.toFixed(2));
    expect(q).toContain('ES Z6 1m bar at 14:42 EDT');
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    expect(askLabel(bar)).toBe("Ask about the 03:42 bar's order flow");
    expect(askQuestion(bar, 'ES Z6', '1m', (p) => p.toFixed(2))).toContain('ES Z6 1m bar at 03:42 GMT+9 on Sat, Oct 3');
    putRuntimeSettings({ 'display.timeZone': null }, false);
    expect(q).toContain('5810.00–5814.50');
    expect(q).toContain('volume 4,100, delta +312');
    expect(q).toContain('Measured numbers first');
  });

  it('lists what the chart’s connection cannot feed with what it needs', () => {
    const out = {
      kinds: [
        {
          kind: 'footprint',
          drawn: true,
          available: false,
          requires: 'footprint',
          reason: 'footprint needs footprint data',
        },
        { kind: 'vwap', drawn: true, available: true, requires: null, reason: null },
        { kind: 'sessions', drawn: false, available: false, requires: null, reason: 'not drawn yet' },
      ],
    } as unknown as LayerKindsOutput;
    const m = unavailableKinds(out);
    expect([...m.keys()]).toEqual(['footprint']);
    expect(requirementWords(m.get('footprint')!.requires)).toBe('Needs trades with aggressor');
    expect(requirementWords(null)).toBe('Not available here');
  });
});

describe('the Order flow template and keys', () => {
  const l = (id: string, kind: string, visible = true) => ({
    id,
    kind,
    params: {},
    visible,
    namespace: 'user' as const,
    sessionId: null,
  });

  it('replaces the chart’s indicators', () => {
    const before = [l('vwap-1', 'vwap'), l('pd', 'levels'), l('rsi-1', 'rsi')];
    const next = withOrderFlow(before);
    expect(next.map((x) => x.kind)).toEqual(['levels', 'footprint', 'volume_profile', 'big_trades', 'delta']);
    expect(isOrderFlow(next)).toBe(true);
    expect(isOrderFlow(before)).toBe(false);
  });

  it('shows or hides a view by its key, adding it with its defaults when absent', () => {
    const added = toggleKind([l('pd', 'levels')], 'footprint');
    expect(added.map((x) => x.id)).toEqual(['pd', 'footprint-1']);
    const hidden = toggleKind(added, 'footprint');
    expect(hidden[1]!.visible).toBe(false);
    expect(toggleKind(hidden, 'footprint')[1]!.visible).toBe(true);
    const keys = orderFlowCommands().map((c) => c.shortcut);
    expect(keys).toEqual(['alt+shift+f', 'alt+p', 'alt+d', 'alt+b', undefined, undefined]);
    expect(orderFlowCommands().at(-2)).toMatchObject({ title: 'Stacked imbalance: show or hide' });
    expect(orderFlowCommands().at(-1)).toMatchObject({ title: 'Market profile: show or hide' });
  });
});

describe('a session split into its overnight and regular hours', () => {
  it('is the session less its regular hours, row by row, spanning to where they begin', () => {
    const tick = 0.25;
    const all = {
      from: 0,
      to: 100,
      label: 'Thu',
      rowTicks: 1,
      lowTick: 10,
      rows: 3,
      volume: Float64Array.from([5, 30, 8]),
      buy: Float64Array.from([2, 20, 4]),
      sell: Float64Array.from([3, 10, 4]),
      levels: { poc: 11 * tick, vah: 12 * tick, val: 10 * tick },
    };
    const rth = {
      ...all,
      from: 60,
      to: 90,
      lowTick: 11,
      rows: 2,
      volume: Float64Array.from([25, 8]),
      buy: Float64Array.from([18, 4]),
      sell: Float64Array.from([7, 4]),
    };
    const eth = withoutRth(all, rth);
    expect([...eth.volume]).toEqual([5, 5, 0]);
    expect([...eth.buy]).toEqual([2, 2, 0]);
    expect([eth.from, eth.to, eth.levels, eth.label]).toEqual([0, 60, null, 'Thu ETH']);
  });
});
