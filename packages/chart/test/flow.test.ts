import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AggTape,
  BOOK_STALE_MS,
  BookStore,
  FootprintStore,
  ProfileAccumulator,
  TickGrid,
  TradeTape,
  aggregatePrints,
  autoRowTicks,
  decideOutcome,
  watchOutcome,
  decimalsOf,
  footprintProfile,
  DEFAULT_IMBALANCE,
  flagsOnRows,
  groupingKey,
  imbalanceFlags,
  nakedPocs,
  pocOf,
  pointOfControl,
  stackedZones,
  withForming,
  stacksOf,
  valueAreaBand,
  BUY_IMBALANCE,
  SELL_IMBALANCE,
  TESSERA_GROUPING,
  type AggPrintInput,
  type DepthMessage,
  type FootprintInput,
  type Grouping,
  type OutcomeKind,
  type OutcomeWatch,
  type Zone,
  type ZoneBars,
} from '../src/index.ts';

const fixtures = join(import.meta.dirname, '../../../fixtures/orderflow');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

const ES = new TickGrid(0.25);

describe('ticks', () => {
  it('maps prices to whole ticks and back without float drift', () => {
    expect(ES.decimals).toBe(2);
    expect(ES.toTick(5812.25)).toBe(23249);
    expect(ES.toPrice(23249)).toBe(5812.25);
    const fx = new TickGrid(0.00005);
    expect(fx.decimals).toBe(5);
    expect(fx.toPrice(fx.toTick(1.08345))).toBe(1.08345);
    const cents = new TickGrid(0.01);
    expect(cents.toPrice(12345)).toBe(123.45);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.1)).toBe(1);
    expect(() => new TickGrid(0)).toThrow();
  });

  it('aligns merged rows to tick 0 so every bar agrees, below zero too', () => {
    expect(ES.rowOf(23249, 4)).toBe(23248);
    expect(ES.rowOf(23248, 4)).toBe(23248);
    expect(ES.rowOf(-1, 4)).toBe(-4);
    expect(ES.rowOf(7, 1)).toBe(7);
  });

  it('picks the smallest row step that fits', () => {
    expect(autoRowTicks(12, 12)).toBe(1);
    expect(autoRowTicks(5, 12)).toBe(4);
    expect(autoRowTicks(2.5, 12)).toBe(5);
    expect(autoRowTicks(0.1, 12)).toBe(200);
    expect(autoRowTicks(0.01, 12)).toBe(2000);
    expect(autoRowTicks(5, 12, 5)).toBe(5);
  });

  it('keeps growing rows on round steps for as far out as the chart zooms', () => {
    for (const tickPx of [1, 0.3, 0.05, 0.004, 0.0007]) {
      const rows = autoRowTicks(tickPx, 3, 4);
      expect(rows * tickPx).toBeGreaterThanOrEqual(3);
      expect(rows % 4).toBe(0);
    }
  });
});

const depth = (
  seq: number,
  kind: DepthMessage['kind'],
  bids: number[][] = [],
  asks: number[][] = [],
): DepthMessage => ({
  seq,
  kind,
  levels: 10,
  bids,
  asks,
});

describe('BookStore', () => {
  it('applies a snapshot, deltas in sequence, and confirms on a heartbeat', () => {
    const b = new BookStore(ES);
    expect(b.isStale(0)).toBe(true);
    expect(
      b.apply(
        depth(
          5,
          'snapshot',
          [
            [5812, 10],
            [5811.75, 20, 3],
          ],
          [
            [5812.25, 7],
            [5812.5, 30],
          ],
        ),
        1000,
      ),
    ).toBe('applied');
    expect(b.bestBid).toBe(ES.toTick(5812));
    expect(b.bestAsk).toBe(ES.toTick(5812.25));
    expect(b.bids.orders[1]).toBe(3);
    expect(b.bids.orders[0]).toBe(-1);
    expect(
      b.apply(
        depth(
          6,
          'delta',
          [[5812.25 - 0.25, 12]],
          [
            [5812.25, 0],
            [5812.5, 25],
          ],
        ),
        1100,
      ),
    ).toBe('applied');
    expect(b.sizeAt('bid', ES.toTick(5812))).toBe(12);
    expect(b.bestAsk).toBe(ES.toTick(5812.5));
    expect(b.sizeAt('ask', ES.toTick(5812.5))).toBe(25);
    expect(b.apply(depth(7, 'delta', [[5812.25, 4]]), 1150)).toBe('applied');
    expect(b.bestBid).toBe(ES.toTick(5812.25));
    expect([...b.bids.ticks.subarray(0, b.bids.length)]).toEqual([23249, 23248, 23247]);
    const v = b.version;
    expect(b.apply(depth(7, 'heartbeat'), 2000)).toBe('alive');
    expect(b.version).toBe(v);
    expect(b.isStale(2000 + BOOK_STALE_MS)).toBe(false);
    expect(b.isStale(2001 + BOOK_STALE_MS)).toBe(true);
    expect(b.behindMs(2400)).toBe(400);
  });

  it('drops what it already holds and waits for a snapshot after a gap', () => {
    const b = new BookStore(ES);
    expect(b.apply(depth(1, 'delta', [[1, 1]]), 0)).toBe('gap');
    b.apply(depth(10, 'snapshot', [[5812, 10]], [[5812.25, 7]]), 0);
    expect(b.apply(depth(9, 'delta', [[5812, 99]]), 0)).toBe('stale');
    expect(b.apply(depth(10, 'delta', [[5812, 99]]), 0)).toBe('stale');
    expect(b.sizeAt('bid', ES.toTick(5812))).toBe(10);
    expect(b.apply(depth(12, 'delta', [[5812, 99]]), 10)).toBe('gap');
    expect(b.isStale(10)).toBe(true);
    expect(b.apply(depth(13, 'delta'), 20)).toBe('gap');
    expect(b.apply(depth(10, 'heartbeat'), 20)).toBe('gap');
    expect(b.apply(depth(11, 'snapshot', [[5811, 5]], []), 30)).toBe('applied');
    expect(b.isStale(30)).toBe(false);
    expect(b.bestBid).toBe(ES.toTick(5811));
    expect(b.bestAsk).toBeNaN();
    expect(b.apply(depth(12, 'delta', [], [[5811.25, 3]]), 40)).toBe('applied');
    expect(b.apply(depth(14, 'heartbeat'), 50)).toBe('gap');
  });

  it('keeps the levels the runtime keeps, sums merged rows and finds walls', () => {
    const b = new BookStore(ES);
    const bids = Array.from({ length: 12 }, (_, k) => [5812 - k * 0.25, k === 3 ? 200 : 10]);
    b.apply({ seq: 1, kind: 'snapshot', levels: 12, bids, asks: [] }, 0);
    b.apply({ seq: 2, kind: 'delta', levels: 10, bids: [[5812.25, 10]], asks: [] }, 0);
    expect(b.bids.length).toBe(10);
    expect(b.bids.ticks[9]).toBe(ES.toTick(5812 - 8 * 0.25));
    expect(b.rowSize('bid', ES.toTick(5811), 4)).toBe(230);
    expect(b.medianSize()).toBe(10);
    expect(b.wallSize()).toBe(40);
    expect(new BookStore(ES).wallSize()).toBe(Infinity);
  });
});

const print = (ns: number, price: number, size: number, side: number, order?: number): number[] =>
  order === undefined ? [ns, price, size, side] : [ns, price, size, side, order];

describe('TradeTape', () => {
  it('applies a snapshot and batches by the runtime count, dropping and trimming what it holds', () => {
    const tape = new TradeTape(ES, 8);
    expect(tape.apply({ seq: 1, trades: [print(1, 5812, 1, 1)] })).toBe('gap');
    tape.applySnapshot({ seq: 3, trades: [print(1, 5812, 1, 1), print(2, 5812.25, 2, -1), print(3, 5812, 3, 0)] });
    expect(tape.length).toBe(3);
    expect(tape.apply({ seq: 3, trades: [print(3, 5812, 3, 0)] })).toBe('stale');
    expect(
      tape.apply({ seq: 5, trades: [print(3, 5812, 3, 0), print(4, 5812.5, 4, 1), print(5, 5812.5, 5, 1, 77)] }),
    ).toBe('applied');
    expect(tape.length).toBe(5);
    expect(tape.apply({ seq: 5, trades: [print(4, 5812.5, 4, 1), print(5, 5812.5, 5, 1, 77)] })).toBe('stale');
    expect(tape.length).toBe(5);
    expect(
      tape.apply({ seq: 7, trades: [print(5, 5812.5, 5, 1, 77), print(6, 5813, 6, -1), print(7, 5813, 7, -1)] }),
    ).toBe('applied');
    expect(tape.length).toBe(7);
    expect(tape.sizeAt(tape.end - 1)).toBe(7);
    expect(tape.apply({ seq: 10, trades: [print(9, 1, 1, 1)] })).toBe('gap');
    expect(tape.orderAt(4)).toBe(77);
    expect(tape.orderAt(3)).toBeNull();
    expect([tape.sideAt(0), tape.sideAt(1), tape.sideAt(2)]).toEqual([1, -1, 0]);
    expect(tape.priceAt(3)).toBe(5812.5);
    expect(tape.msAt(0)).toBe(1e-6);
    tape.apply({ seq: 9, trades: [print(8, 5813, 8, 1), print(9, 5813, 9, 1)] });
    expect(tape.length).toBe(8);
    expect(tape.start).toBe(1);
    expect(tape.sizeAt(tape.start)).toBe(2);
    expect(tape.lowerBound(5)).toBe(4);
    expect(tape.upperBound(5)).toBe(5);
    expect(tape.lowerBound(0)).toBe(tape.start);
  });

  it('keeps its prints across a snapshot that continues the count, and starts over on another', () => {
    const tape = new TradeTape(ES, 16);
    tape.applySnapshot({ seq: 2, trades: [print(1, 1, 1, 1), print(2, 1, 2, 1)] });
    const epoch = tape.epoch;
    tape.applySnapshot({ seq: 4, trades: [print(2, 1, 2, 1), print(3, 1, 3, 1), print(4, 1, 4, 1)] });
    expect(tape.length).toBe(4);
    expect(tape.epoch).toBe(epoch);
    tape.applySnapshot({ seq: 100, trades: [print(50, 1, 9, 1)] });
    expect(tape.length).toBe(1);
    expect(tape.epoch).toBe(epoch + 1);
    expect(tape.bytes).toBe(16 * 21);
  });
});

interface AggFixture {
  cases: {
    name: string;
    tick: number;
    prints: AggPrintInput[];
    events: number[][];
    settings?: (Grouping & { events: number[][] })[];
  }[];
}

describe('aggregation (shared fixture with the runtime)', () => {
  const { cases } = fixture('aggregate.json') as AggFixture;
  const groupedCases = cases.flatMap((c) =>
    [
      { grouping: TESSERA_GROUPING, events: c.events },
      ...(c.settings ?? []).map(({ events, ...grouping }) => ({ grouping, events })),
    ].map((g) => ({ ...c, ...g, label: `${c.name} (${groupingKey(g.grouping)})` })),
  );
  const expectEvents = (label: string, got: number[][], events: number[][]) => {
    expect(got.length, label).toBe(events.length);
    got.forEach((o, k) => {
      const want = events[k]!;
      expect(o[1], label).toBeCloseTo(want[1]!, 6);
      expect([o[0], ...o.slice(2)], label).toEqual([want[0], ...want.slice(2)]);
    });
  };

  it('holds a case for each of the four groupings', () => {
    expect(new Set(groupedCases.map((c) => groupingKey(c.grouping)))).toEqual(
      new Set(['orders|reach', 'chain|reach', 'orders|walk', 'chain|walk']),
    );
  });

  for (const c of groupedCases) {
    it(c.label, () => {
      const got = aggregatePrints(c.prints, c.tick, c.grouping).map((o) => [
        o.t,
        o.price,
        o.size,
        o.side,
        o.prints,
        o.levels,
        o.orders,
      ]);
      expectEvents(c.label, got, c.events);
    });
  }

  it('reads the same orders live from the tape, batch by batch, whatever the split', () => {
    for (const c of groupedCases) {
      for (const split of [1, 2, 3]) {
        const grid = new TickGrid(c.tick);
        const tape = new TradeTape(grid, 64);
        const agg = new AggTape(tape, 64, c.grouping);
        tape.applySnapshot({ seq: 0, trades: [] });
        for (let k = 0; k < c.prints.length; k += split) {
          const batch = c.prints.slice(k, k + split);
          tape.apply({ seq: (tape.seq ?? 0) + batch.length, trades: batch });
          agg.sync();
        }
        const got = [];
        for (let i = agg.start; i < agg.end; i++) {
          const o = agg.at(i);
          got.push([o.t, o.price, o.size, o.side, o.prints, o.levels, o.orders]);
        }
        expectEvents(`${c.label} split ${String(split)}`, got, c.events);
      }
    }
  });
});

const fp = (t: number, cells: number[][], extra: Partial<FootprintInput> = {}): FootprintInput => ({
  t,
  row: 0.25,
  cells,
  deltaHigh: null,
  deltaLow: null,
  ...extra,
});

describe('FootprintStore', () => {
  it('tints against one reference over the newest closed bars, 1.5 times their mean row, per row size', () => {
    const s = new FootprintStore(ES);
    s.setHistory(
      [
        fp(0, [
          [5811, 3, 1],
          [5811.25, 2, 9],
        ]),
        fp(60_000, [[5812, 100, 0]]),
      ],
      true,
    );
    expect(s.tintScale(1)).toEqual({ volume: 1.5 * 7.5, delta: 1.5 * 4.5 });
    expect(s.tintScale(2)).toEqual({ volume: 1.5 * 15, delta: 1.5 * 5 });
    s.apply({ bar: fp(60_000, [[5812, 100, 0]]), closed: true, partial: false });
    expect(s.tintScale(1)).toEqual({ volume: 1.5 * (115 / 3), delta: 1.5 * (109 / 3) });
    const fresh = new FootprintStore(ES);
    fresh.setHistory([fp(0, [[5811, 4, 0]])], true);
    expect(fresh.tintScale(1)).toEqual({ volume: 6, delta: 6 });
    fresh.apply({ bar: fp(0, [[5811, 8, 0]]), closed: false, partial: true });
    expect(fresh.tintScale(1)).toEqual({ volume: 12, delta: 12 });
  });

  it('merges forming updates by keeping the larger of each side, and replaces a bar when it closes', () => {
    const s = new FootprintStore(ES);
    expect(s.apply({ bar: fp(60_000, [[5812, 1, 2]]), closed: false, partial: true })).toBe('reload');
    s.setHistory([
      fp(0, [
        [5811, 3, 1],
        [5811.25, 2, 9],
      ]),
    ]);
    expect(
      s.apply({ bar: fp(60_000, [[5812, 1, 2]], { deltaHigh: 1, deltaLow: 0 }), closed: false, partial: false }),
    ).toBe('applied');
    s.apply({
      bar: fp(
        60_000,
        [
          [5812, 4, 2],
          [5812.5, 0, 6],
        ],
        { deltaHigh: 3, deltaLow: -2 },
      ),
      closed: false,
      partial: true,
    });
    s.apply({ bar: fp(60_000, [[5812, 2, 1]], { deltaHigh: 0, deltaLow: 0 }), closed: false, partial: true });
    const bar = s.get(60_000)!;
    expect(bar.rows).toBe(3);
    expect([...bar.bid]).toEqual([4, 0, 0]);
    expect([...bar.ask]).toEqual([2, 0, 6]);
    expect([bar.deltaHigh, bar.deltaLow]).toEqual([3, -2]);
    expect(bar.volume).toBe(12);
    expect(bar.delta).toBe(4);
    expect(s.indexAtOrBefore(59_999)).toBe(0);
    expect(s.indexAtOrBefore(60_000)).toBe(1);
    expect(s.firstTime).toBe(0);
    s.apply({ bar: fp(60_000, [[5812, 5, 5]], { deltaHigh: 2, deltaLow: -1 }), closed: true, partial: false });
    const closed = s.get(60_000)!;
    expect(closed.closed).toBe(true);
    expect([...closed.bid]).toEqual([5]);
    expect(closed.deltaHigh).toBe(2);
  });

  it('merges rows to any size aligned to tick 0, caches a view until the bar changes, and finds the POC', () => {
    const s = new FootprintStore(ES);
    s.setHistory(
      [
        fp(0, [
          [5811.75, 1, 1],
          [5812, 2, 3],
          [5812.25, 4, 0],
          [5812.5, 0, 6],
          [5812.75, 1, 1],
          [5813, 5, 5],
        ]),
      ],
      true,
    );
    const bar = s.at(0)!;
    const v = s.view(bar, 4);
    expect(v.lowTick).toBe(23244);
    expect(v.rows).toBe(3);
    expect([...v.bid]).toEqual([1, 7, 5]);
    expect([...v.ask]).toEqual([1, 10, 5]);
    expect(v.poc).toBe(1);
    expect(v.maxVolume).toBe(17);
    expect(v.maxSide).toBe(10);
    expect(v.volume).toBe(29);
    expect(v.delta).toBe(3);
    expect(s.view(bar, 4)).toBe(v);
    s.apply({ bar: fp(0, [[5813, 9, 5]]), closed: false, partial: true });
    const v2 = s.view(bar, 4);
    expect(v2).not.toBe(v);
    expect(v2.bid[2]).toBe(9);
    expect(s.view(bar, 1).rowTicks).toBe(1);
    expect(s.bytes).toBeGreaterThan(0);
  });

  it('breaks a POC tie toward the middle, then the lower row', () => {
    expect(pocOf((r) => [9, 1, 2, 9, 1][r]!, 5)).toBe(3);
    expect(pocOf((r) => [1, 7, 7, 1][r]!, 4)).toBe(1);
    expect(pocOf(() => 0, 3)).toBe(-1);
  });

  it('keeps the newest bars within its capacity', () => {
    const s = new FootprintStore(ES, 3);
    s.setHistory([0, 1, 2, 3, 4].map((k) => fp(k * 60_000, [[5812, 1, 1]])));
    expect(s.length).toBe(3);
    expect(s.firstTime).toBe(120_000);
    expect(s.get(0)).toBeUndefined();
  });
});

interface ImbalanceFixture {
  cases: {
    name: string;
    rows: [number, number][];
    ratio: number;
    minVolume: number;
    minDifference: number;
    includeZero: boolean;
    stackRows: number;
    buy: number[];
    sell: number[];
    stacks: [string, number, number][];
  }[];
}

describe('imbalances (fixture)', () => {
  for (const c of (fixture('imbalance.json') as ImbalanceFixture).cases) {
    it(c.name, () => {
      const rows = { rows: c.rows.length, bid: c.rows.map((r) => r[0]), ask: c.rows.map((r) => r[1]) };
      const flags = imbalanceFlags(rows, c);
      const at = (bit: number) => [...flags].flatMap((f, r) => ((f & bit) !== 0 ? [r] : []));
      expect(at(BUY_IMBALANCE)).toEqual(c.buy);
      expect(at(SELL_IMBALANCE)).toEqual(c.sell);
      expect(stacksOf(flags, rows.rows, c.stackRows).map((s) => [s.side, s.low, s.high])).toEqual(c.stacks);
    });
  }

  it('reuses a flags buffer', () => {
    const buf = new Uint8Array(8).fill(3);
    const out = imbalanceFlags({ rows: 2, bid: [0, 0], ask: [0, 0] }, DEFAULT_IMBALANCE, buf);
    expect(out).toBe(buf);
    expect([...out.subarray(0, 2)]).toEqual([0, 0]);
  });

  it('marks each shown row that holds an imbalanced row', () => {
    const found = { rows: 8, lowTick: 100, rowTicks: 1 };
    const flags = Uint8Array.from([0, BUY_IMBALANCE, 0, 0, SELL_IMBALANCE, BUY_IMBALANCE, 0, 0]);
    const shown = { rows: 3, lowTick: 100, rowTicks: 4 };
    expect([...flagsOnRows(found, flags, shown)]).toEqual([BUY_IMBALANCE, BUY_IMBALANCE | SELL_IMBALANCE, 0]);
  });
});

describe('stacked zones', () => {
  function zoneBars(later: [number, number, number][]): ZoneBars {
    const s = new FootprintStore(ES);
    s.setHistory([
      fp(0, [
        [5812, 5, 1],
        [5812.25, 1, 20],
        [5812.5, 1, 20],
        [5812.75, 1, 20],
        [5813, 30, 2],
      ]),
    ]);
    const lows = [23248, ...later.map((b) => b[0])];
    const highs = [23252, ...later.map((b) => b[1])];
    const sessions = [0, ...later.map((b) => b[2])];
    return {
      length: lows.length,
      view: (i) => (i === 0 ? s.view(s.at(0)!, 1) : null),
      lowTick: (i) => lows[i]!,
      highTick: (i) => highs[i]!,
      session: (i) => sessions[i]!,
    };
  }
  const opts = DEFAULT_IMBALANCE;

  it('extends right and stops at the first bar whose range reaches into it', () => {
    const zones = stackedZones(
      zoneBars([
        [23253, 23260, 0],
        [23252, 23255, 0],
        [23240, 23249, 0],
        [23200, 23300, 0],
      ]),
      0,
      0,
      opts,
    );
    expect(zones).toEqual([{ side: 'buy', lowTick: 23249, highTick: 23252, from: 0, to: 3, open: false }]);
  });

  it('stays open to the right edge while untouched, and ends after three sessions', () => {
    expect(
      stackedZones(
        zoneBars([
          [23260, 23270, 0],
          [23260, 23270, 1],
        ]),
        0,
        0,
        opts,
      )[0],
    ).toMatchObject({
      to: 2,
      open: true,
    });
    expect(
      stackedZones(
        zoneBars([
          [23260, 23270, 1],
          [23260, 23270, 2],
          [23260, 23270, 3],
          [23200, 23300, 3],
        ]),
        0,
        0,
        opts,
      )[0],
    ).toMatchObject({ to: 2, open: false });
  });
});

describe('stacked zones of a forming bar', () => {
  it('equal the full scan when the bars before the last are kept and only the last is read again', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const opts = { ...DEFAULT_IMBALANCE, stackRows: 2 };
    let open = 0;
    let stopped = 0;
    for (let run = 0; run < 20; run++) {
      const s = new FootprintStore(ES);
      const lows: number[] = [];
      const highs: number[] = [];
      const sessions: number[] = [];
      const inputs: FootprintInput[] = [];
      let mid = 23250;
      for (let i = 0; i < 120; i++) {
        mid += Math.round((rnd() - 0.3) * 8);
        const low = mid - 1 - Math.floor(rnd() * 4);
        const high = mid + 1 + Math.floor(rnd() * 4);
        const cells: number[][] = [];
        for (let t = low; t <= high; t++) cells.push([t * 0.25, Math.floor(rnd() * 30), Math.floor(rnd() * 30)]);
        inputs.push(fp(i * 60_000, cells));
        lows.push(low);
        highs.push(high);
        sessions.push(Math.floor(i / 30));
      }
      s.setHistory(inputs);
      const bars = (length: number): ZoneBars => ({
        length,
        view: (i) => s.view(s.at(i)!, 1),
        lowTick: (i) => lows[i]!,
        highTick: (i) => highs[i]!,
        session: (i) => sessions[i]!,
      });
      const n = inputs.length;
      const full = stackedZones(bars(n), 0, n - 1, opts);
      const split = withForming(stackedZones(bars(n - 1), 0, n - 2, opts), bars(n), n - 1, opts);
      const order = (zs: Zone[]) =>
        [...zs].sort((a, b) => a.from - b.from || a.lowTick - b.lowTick || a.side.localeCompare(b.side));
      expect(order(split)).toEqual(order(full));
      open += full.filter((z) => z.open).length;
      stopped += full.filter((z) => !z.open).length;
    }
    expect(open).toBeGreaterThan(0);
    expect(stopped).toBeGreaterThan(0);
  });

  it('leaves the settled bars alone while the newest bar forms, and moves on when a bar closes', () => {
    const s = new FootprintStore(ES);
    s.setHistory([fp(0, [[5812, 1, 1]]), fp(60_000, [[5812, 1, 1]])], true);
    const settled = s.settledVersion;
    s.apply({ bar: fp(60_000, [[5812.25, 3, 1]]), closed: false, partial: true });
    expect(s.settledVersion).toBe(settled);
    s.apply({ bar: fp(60_000, [[5812.25, 3, 1]]), closed: true, partial: false });
    expect(s.settledVersion).toBe(settled + 1);
  });
});

interface ValueAreaFixture {
  cases: { name: string; volumes: number[]; share: number; poc: number; val: number; vah: number; held: number }[];
}

describe('profile (shared fixture with the runtime)', () => {
  for (const c of (fixture('value_area.json') as ValueAreaFixture).cases) {
    it(c.name, () => {
      const poc = pointOfControl(c.volumes);
      expect(poc).toBe(c.poc);
      expect(valueAreaBand(c.volumes, poc, c.share)).toEqual([c.val, c.vah, c.held]);
      expect(valueAreaBand(Float64Array.from(c.volumes), poc, c.share)).toEqual([c.val, c.vah, c.held]);
      const acc = new ProfileAccumulator(1);
      c.volumes.forEach((v, i) => {
        acc.add(1000 + i, v, 0);
      });
      const p = acc.profile(c.share);
      const lead = c.volumes.findIndex((v) => v > 0);
      expect(p.poc + lead).toBe(c.poc);
      expect(p.total).toBe(c.volumes.reduce((a, b) => a + b, 0));
    });
  }

  it('profiles visible footprint bars at a row size', () => {
    const s = new FootprintStore(ES);
    s.setHistory([
      fp(0, [
        [5812, 2, 3],
        [5812.25, 1, 1],
      ]),
      fp(60_000, [
        [5812.25, 10, 0],
        [5813, 0, 4],
      ]),
      fp(120_000, [[5900, 50, 50]]),
    ]);
    const p = footprintProfile(s, 0, 1, 2)!;
    expect(p.lowTick).toBe(23248);
    expect(p.rows).toBe(3);
    expect([...p.volume]).toEqual([17, 0, 4]);
    expect([...p.buy]).toEqual([4, 0, 4]);
    expect([...p.sell]).toEqual([13, 0, 0]);
    expect(p.poc).toBe(0);
    expect([p.val, p.vah]).toEqual([0, 0]);
    expect(p.maxVolume).toBe(17);
    expect(footprintProfile(s, 5, 9, 1)).toBeNull();
  });

  it('keeps the naked POCs of the last sessions until price trades through them', () => {
    const lows = [100, 100, 100, 130, 90];
    const highs = [110, 110, 110, 140, 95];
    const bars = { length: 5, lowTick: (i: number) => lows[i]!, highTick: (i: number) => highs[i]! };
    const pocs = [
      { tick: 104, rowTicks: 1, lastBar: 0, label: 'Mon' },
      { tick: 120, rowTicks: 4, lastBar: 2, label: 'Tue' },
      { tick: 132, rowTicks: 1, lastBar: 2, label: 'Tue2' },
      { tick: 96, rowTicks: 1, lastBar: 3, label: 'Wed' },
    ];
    expect(nakedPocs(pocs, bars).map((p) => p.label)).toEqual(['Wed', 'Tue']);
    expect(nakedPocs(pocs, bars, 1).map((p) => p.label)).toEqual(['Wed']);
  });
});

describe('volume nodes', () => {
  it('finds the peaks and the valleys between them that stand out, and none in noise', async () => {
    const { volumeNodes } = await import('../src/flow/profile.ts');
    const v = Array.from(
      { length: 100 },
      (_, i) => 10 + 200 * Math.exp(-((i - 20) ** 2) / 40) + 150 * Math.exp(-((i - 70) ** 2) / 60),
    );
    const { hvn, lvn } = volumeNodes(v);
    expect(hvn).toHaveLength(2);
    expect(Math.abs(hvn[0]! - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(hvn[1]! - 70)).toBeLessThanOrEqual(2);
    expect(lvn).toHaveLength(1);
    expect(lvn[0]!).toBeGreaterThan(30);
    expect(lvn[0]!).toBeLessThan(60);
    const flat = Array.from({ length: 100 }, (_, i) => 100 + (i % 3));
    expect(volumeNodes(flat)).toEqual({ hvn: [], lvn: [] });
    expect(volumeNodes([1, 2])).toEqual({ hvn: [], lvn: [] });
  });
});

interface OutcomeFixture {
  cases: {
    name: string;
    tick: number;
    reachTicks: number;
    prints: AggPrintInput[];
    outcomes: [number, number, number, OutcomeKind | null, number | null][];
  }[];
}

describe('what happened after each event (shared fixture with the runtime)', () => {
  const { cases } = fixture('outcome.json') as OutcomeFixture;

  for (const c of cases) {
    it(c.name, () => {
      for (const split of [1, 2, 3]) {
        const tape = new TradeTape(new TickGrid(c.tick), 64);
        const agg = new AggTape(tape, 64, TESSERA_GROUPING);
        tape.applySnapshot({ seq: 0, trades: [] });
        const decided = new Map<number, [OutcomeKind, number]>();
        const watching = new Map<number, OutcomeWatch>();
        let watched = 0;
        for (let k = 0; k < c.prints.length; k += split) {
          const batch = c.prints.slice(k, k + split);
          tape.apply({ seq: (tape.seq ?? 0) + batch.length, trades: batch });
          agg.sync();
          for (; watched < agg.closedEnd; watched++) {
            const w = watchOutcome(agg, watched, c.reachTicks);
            if (w) watching.set(watched, w);
          }
          for (const [i, w] of watching) {
            const at = decideOutcome(tape, w);
            if (!at) continue;
            decided.set(i, [at.kind, at.decidedNs]);
            watching.delete(i);
          }
        }
        const got = [];
        for (let i = agg.start; i < agg.end; i++) {
          const o = agg.at(i);
          if (o.side === 0) continue;
          const [kind, at] = decided.get(i) ?? [null, null];
          got.push([o.t, o.side, o.size, kind, at]);
        }
        expect(got, `${c.name} split ${String(split)}`).toEqual(c.outcomes);
      }
    });
  }

  it('reads nothing twice: a watch moves past the prints it has read', () => {
    const tape = new TradeTape(new TickGrid(0.25), 64);
    const agg = new AggTape(tape, 64, TESSERA_GROUPING);
    tape.applySnapshot({
      seq: 2,
      trades: [
        [1e9, 5000, 30, 1],
        [2e9, 5000.25, 1, -1],
      ],
    });
    agg.sync();
    const w = watchOutcome(agg, 0, 2)!;
    expect(decideOutcome(tape, w)).toBeNull();
    expect(w.next).toBe(2);
    tape.apply({ seq: 3, trades: [[3e9, 4999.5, 1, -1]] });
    expect(decideOutcome(tape, w)).toEqual({ kind: 'absorbed', decidedNs: 3e9 });
  });
});
