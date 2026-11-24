import { BookStore, TickGrid, TradeTape } from '@tessera/chart';
import type { AccountUpdate, DraftInfo, Order, OrderRole, Position, Side } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { groupBrackets } from '../src/chart/brackets.ts';
import {
  clickAt,
  placeAt,
  beginPlacement,
  placementFor,
  type PlaceBase,
  type PlaceQuote,
} from '../src/chart/placement.ts';
import { DEFAULT_OCO } from '../src/shell/oco.ts';
import {
  DEFAULT_DOM_PARAMS,
  PressGate,
  PriceLabels,
  RecentVolume,
  autoCentred,
  centredOn,
  droppedWords,
  edgeMarks,
  edgeOf,
  entriesOpen,
  feedState,
  joinTags,
  ladderRows,
  ladderTags,
  ocoWords,
  outsideMiddle,
  pnlAt,
  readDomParams,
  readOnlyWords,
  roundStep,
  rowIndex,
  rowLow,
  scrolled,
  sessionVolume,
  sizeWords,
  stepRowTicks,
  stripFor,
  tagTitle,
  tagWords,
  tradeTick,
  verbWords,
  withRowTicks,
  withRows,
  type FeedState,
  type LadderFrameInput,
  type StripInput,
} from '../src/orderflow/dom/ladderModel.ts';
import {
  continuing,
  hoverTrade,
  menuTrades,
  cellKind,
  placeBaseFor,
  tradeClick,
  type DomTradeSetup,
} from '../src/orderflow/dom/trading.ts';
import { startPlacement, placementStore, endPlacement } from '../src/state/placement.ts';
import { read } from '../src/app/store.ts';
import { setTestServices } from './support/runtime.tsx';

const ES = 'ESZ6.CME';
const ids = new Set([ES, 'ES']);
const grid = new TickGrid(0.25, 2);
const t = (price: number) => grid.toTick(price);

function book(bids: [number, number][], asks: [number, number][], now = 1000): BookStore {
  const b = new BookStore(grid);
  b.apply({ seq: 1, kind: 'snapshot', levels: 10, bids, asks }, now);
  return b;
}

let n = 0;
function order(o: {
  side: Side;
  type: 'limit' | 'stop';
  price: number;
  qty?: number;
  role?: OrderRole;
  parent?: string | null;
  status?: Order['status'];
}): Order {
  n += 1;
  return {
    id: `o${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: ES,
      side: o.side,
      qty: o.qty ?? 1,
      orderType: o.type,
      limitPrice: o.type === 'limit' ? o.price : null,
      stopPrice: o.type === 'stop' ? o.price : null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: o.role === 'stop_loss' || o.role === 'take_profit',
    },
    role: o.role ?? 'entry',
    parentId: o.parent ?? null,
    status: o.status ?? 'working',
    filledQty: 0,
    avgFillPrice: null,
    queueAhead: null,
    triggeredAt: null,
    environment: 'paper',
    reason: null,
    createdAt: 1_759_430_000_000,
    updatedAt: 1_759_430_000_000,
  };
}

const position = (qty: number, avg: number): Position => ({
  accountId: 'paper-main',
  instrument: ES,
  qty,
  avgPrice: avg,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: { amount: 0, currency: 'USD' },
  mark: 5812,
  openedAt: 1_759_430_000_000,
});

function frame(over: Partial<LadderFrameInput> = {}): LadderFrameInput {
  return {
    window: centredOn(t(5812), 1, 11, 1),
    count: 11,
    book: book(
      [
        [5812, 10],
        [5811.75, 20],
        [5811.5, 200],
      ],
      [
        [5812.25, 8],
        [5812.5, 12],
      ],
    ),
    last: t(5812),
    volume: null,
    tags: [],
    average: null,
    toPrice: (x) => grid.toPrice(x),
    decimals: 2,
    tick: 0.25,
    ...over,
  };
}

describe('DOM tile params', () => {
  it('reads stored params, keeping what is valid and defaulting the rest', () => {
    expect(readDomParams(undefined)).toEqual(DEFAULT_DOM_PARAMS);
    expect(
      readDomParams({ link: 'A', instrument: 'NQ', rowTicks: 4, volumeColumn: 'recent', autoCentre: false }),
    ).toEqual({
      ...DEFAULT_DOM_PARAMS,
      link: '1',
      instrument: 'NQ',
      rowTicks: 4,
      volumeColumn: 'recent',
      autoCentre: false,
    });
    expect(
      readDomParams({ orders: false, traded: 'recent', pullStack: 10, pnl: false, refills: false, queue: false }),
    ).toEqual({
      ...DEFAULT_DOM_PARAMS,
      orders: false,
      traded: 'recent',
      pullStack: 10,
      pnl: false,
      refills: false,
      queue: false,
    });
    expect(readDomParams({ traded: 'bars', pullStack: 7 })).toEqual(DEFAULT_DOM_PARAMS);
    expect(readDomParams({ rowTicks: 3, volumeColumn: 'bars', autoCentre: 'yes', link: '' })).toEqual(
      DEFAULT_DOM_PARAMS,
    );
  });

  it('steps the row size through 1, 2, 4, 5, 10 and holds at the ends', () => {
    expect(stepRowTicks(1, 1)).toBe(2);
    expect(stepRowTicks(4, 1)).toBe(5);
    expect(stepRowTicks(10, 1)).toBe(10);
    expect(stepRowTicks(1, -1)).toBe(1);
    expect(stepRowTicks(5, -1)).toBe(4);
  });
});

describe('the window of prices', () => {
  it('puts a tick in the middle row and maps rows to ticks both ways', () => {
    const w = centredOn(t(5812), 1, 11, 0);
    expect(rowIndex(w, t(5812))).toBe(5);
    expect(rowLow(w, 0)).toBe(t(5813.25));
    expect(rowIndex(w, t(5813.25))).toBe(0);
  });

  it('merges rows from tick 0, so the DOM and the footprint agree on which prices share a row', () => {
    const w = centredOn(t(5812.75), 4, 9, 0);
    expect(rowLow(w, rowIndex(w, t(5812.75)))).toBe(t(5812));
    expect(rowIndex(w, t(5812))).toBe(rowIndex(w, t(5812.75)));
  });

  it('recentres only when the price leaves the middle half, and never under the pointer or while paused', () => {
    const w = centredOn(t(5812), 1, 20, 0);
    expect(outsideMiddle(w, t(5812))).toBe(false);
    expect(outsideMiddle(w, t(5812) + 4)).toBe(false);
    expect(outsideMiddle(w, t(5812) + 6)).toBe(true);
    const far = t(5812) + 6;
    const on = { paused: false, pointerOver: false, enabled: true };
    const moved = autoCentred(w, far, on);
    expect(rowIndex(moved, far)).toBe(9);
    expect(moved.gen).toBe(w.gen + 1);
    expect(autoCentred(w, far, { ...on, pointerOver: true })).toBe(w);
    expect(autoCentred(w, far, { ...on, paused: true })).toBe(w);
    expect(autoCentred(w, far, { ...on, enabled: false })).toBe(w);
  });

  it('changes gen on every move of the prices: scroll, row size, a new height', () => {
    const w = centredOn(t(5812), 1, 11, 3);
    expect(scrolled(w, 2).top).toBe(w.top + 2);
    expect(scrolled(w, 2).gen).toBe(4);
    expect(scrolled(w, 0)).toBe(w);
    const merged = withRowTicks(w, 4, t(5812));
    expect(merged.rowTicks).toBe(4);
    expect(merged.gen).toBe(4);
    expect(rowIndex(merged, t(5812))).toBe(5);
    expect(withRows(w, 11)).toBe(w);
    expect(withRows(w, 21).gen).toBe(4);
  });

  it('says where the price is when it is out of the whole rows', () => {
    const w = centredOn(t(5812), 1, 11, 0);
    expect(edgeOf(w, t(5812))).toBeNull();
    expect(edgeOf(w, t(5812) + 6)).toBe('above');
    expect(edgeOf(w, t(5812) - 6)).toBe('below');
    expect(edgeOf(w, null)).toBeNull();
  });
});

describe('ladder rows', () => {
  it('fills each row from the book: sizes, the inside, walls, bars by the largest size in view, the last price', () => {
    const rows = ladderRows(frame());
    const at = (price: number) => rows.find((r) => r.low === t(price))!;
    expect(rows).toHaveLength(11);
    expect(at(5812)).toMatchObject({ price: '5,812.00', bid: 10, ask: 0, bestBid: true, last: true, round: true });
    expect(at(5812.25)).toMatchObject({ ask: 8, bestAsk: true, round: false });
    expect(at(5811.5)).toMatchObject({ bid: 200, bidBar: 1, bidWall: true });
    expect(at(5811.75).bidBar).toBeCloseTo(0.1);
    expect(at(5811.75).bidWall).toBe(false);
  });

  it('writes the frame before’s rows in place, keeps price strings, and holds the bar scale while the largest stays', () => {
    const held: ReturnType<typeof ladderRows> = [];
    const labels = new PriceLabels();
    const first = ladderRows(frame(), held, labels);
    expect(first).toBe(held);
    const row = first[0]!;
    const at = (price: number) => held.find((r) => r.low === t(price))!;
    expect(at(5811.5).bidBar).toBe(1);
    const b = frame().book as BookStore;
    b.apply({ seq: 2, kind: 'delta', levels: 10, bids: [[5811.5, 150]], asks: [] }, 1000);
    const second = ladderRows(frame({ book: b }), held, labels);
    expect(second).toBe(held);
    expect(second[0]).toBe(row);
    expect(at(5811.5).bidBar).toBeCloseTo(0.75);
    expect(at(5811.75).bidBar).toBeCloseTo(0.1);
    b.apply({ seq: 3, kind: 'delta', levels: 10, bids: [[5811.5, 100]], asks: [] }, 1000);
    ladderRows(frame({ book: b }), held, labels);
    expect(at(5811.5).bidBar).toBe(1);
    expect(at(5811.75).bidBar).toBeCloseTo(0.2);
    ladderRows(frame({ book: b, window: centredOn(t(5815), 1, 11, 2) }), held, labels);
    expect(held[0]!.price).toBe(grid.toPrice(held[0]!.low).toLocaleString('en-US', { minimumFractionDigits: 2 }));
    ladderRows(frame({ book: b, window: centredOn(t(5812), 4, 11, 3) }), held, labels);
    expect(held.every((r) => r.round === Math.abs(grid.toPrice(r.low) % roundStep(0.25, 4)) < 1e-9)).toBe(true);
  });

  it('sums sizes per bucket when rows merge', () => {
    const rows = ladderRows(frame({ window: centredOn(t(5812), 2, 5, 0) }));
    const r = rows.find((x) => x.low === t(5811.5))!;
    expect(r.bid).toBe(220);
    expect(rows.find((x) => x.low === t(5812))!).toMatchObject({ bid: 10, ask: 8, bestBid: true, bestAsk: true });
  });

  it('sends a merged row at the bucket price nearest the inside market', () => {
    const b = book([[5812, 10]], [[5812.25, 8]]);
    expect(grid.toPrice(tradeTick('buy', t(5812), 2, b))).toBe(5812);
    expect(grid.toPrice(tradeTick('sell', t(5812), 2, b))).toBe(5812.25);
    expect(grid.toPrice(tradeTick('buy', t(5810), 2, b))).toBe(5810.25);
    expect(grid.toPrice(tradeTick('sell', t(5814), 4, b))).toBe(5814);
    expect(tradeTick('buy', t(5810), 1, b)).toBe(t(5810));
  });

  it('reads round prices at a nice step at least four rows tall', () => {
    expect(roundStep(0.25, 1)).toBe(1);
    expect(roundStep(0.25, 2)).toBe(2);
    expect(roundStep(0.25, 5)).toBe(5);
    expect(roundStep(0.01, 1)).toBeCloseTo(0.05);
  });

  it('shows session volume per row with its POC, and the last minute split by aggressor', () => {
    const vol = sessionVolume({
      lowTick: t(5811),
      rowTicks: 1,
      rows: 5,
      volume: [10, 40, 300, 25, 5],
      buy: [5, 20, 200, 10, 5],
      sell: [5, 20, 100, 15, 0],
    })!;
    expect(vol.poc).toBe(t(5811.5));
    expect(vol.at(t(5811.5), 2)).toEqual({ total: 325, buy: 210, sell: 115 });
    const rows = ladderRows(frame({ volume: vol }));
    const poc = rows.find((r) => r.poc)!;
    expect(poc.low).toBe(t(5811.5));
    expect(poc.volBar).toBe(1);

    const tape = new TradeTape(grid, 64);
    const ns = (ms: number) => ms * 1e6;
    tape.applySnapshot({
      seq: 3,
      trades: [
        [ns(1000), 5812, 2, 1],
        [ns(30_000), 5812, 3, -1],
        [ns(61_500), 5812.25, 4, 1],
      ],
    });
    const recent = new RecentVolume(60_000);
    expect(recent.sync(tape, 62_000)).toBe(true);
    expect(recent.at(t(5812), 1)).toEqual({ total: 3, buy: 0, sell: 3 });
    expect(recent.at(t(5812.25), 1)).toEqual({ total: 4, buy: 4, sell: 0 });
    tape.apply({ seq: 4, trades: [[ns(62_100), 5812, 1, 1]] });
    expect(recent.sync(tape, 95_000)).toBe(true);
    expect(recent.at(t(5812), 1)).toEqual({ total: 1, buy: 1, sell: 0 });
    expect(recent.sync(tape, 95_000)).toBe(false);
  });

  it('takes the session POC by the shared rule: among equal maxima the row nearest the middle, then the lower', () => {
    const base = { lowTick: t(5811), rowTicks: 1, buy: [0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0] };
    const vol = sessionVolume({ ...base, rows: 6, volume: [50, 10, 50, 50, 10, 0] })!;
    expect(vol.poc).toBe(t(5811.5));
    expect(sessionVolume({ ...base, rows: 3, volume: [0, 0, 0] })!.poc).toBeNull();
  });
});

describe('ladder tags', () => {
  it('puts buys in the bid gutter and sells in the ask gutter, the position at its average, exits on the closing side', () => {
    const entry = order({ side: 'buy', type: 'limit', price: 5810, qty: 2 });
    const stop = order({
      side: 'sell',
      type: 'stop',
      price: 5806,
      role: 'stop_loss',
      parent: entry.id,
      status: 'held',
    });
    const exit = order({ side: 'sell', type: 'limit', price: 5816, role: 'take_profit', qty: 1 });
    const sent = order({ side: 'sell', type: 'limit', price: 5815, status: 'pending_submit' });
    const brackets = groupBrackets([entry, stop, exit, sent], [position(1, 5811.5)], [], ids);
    const tags = ladderTags(brackets, 0.25);
    const pos = tags.find((x) => x.role === 'position')!;
    expect(pos).toMatchObject({ side: 'buy', qty: 1, tick: t(5811.5) });
    expect(tagWords(pos)).toBe('+1');
    expect(tags.find((x) => x.role === 'entry' && x.tick === t(5810))).toMatchObject({
      side: 'buy',
      qty: 2,
      state: 'working',
    });
    expect(tags.find((x) => x.role === 'stop')).toMatchObject({ side: 'sell', state: 'held', tick: t(5806) });
    expect(tags.find((x) => x.role === 'target')).toMatchObject({ side: 'sell', state: 'working', tick: t(5816) });
    expect(tags.find((x) => x.tick === t(5815))).toMatchObject({ state: 'sent' });
  });

  it('says in plain words whose order a chip is, how many are ahead of it, and when a leg is placed', () => {
    const entry = order({ side: 'buy', type: 'limit', price: 5810, qty: 1 });
    const stop = order({
      side: 'sell',
      type: 'stop',
      price: 5800,
      role: 'stop_loss',
      parent: entry.id,
      status: 'held',
    });
    const target = order({
      side: 'sell',
      type: 'limit',
      price: 5830,
      role: 'take_profit',
      parent: entry.id,
      status: 'held',
    });
    const tags = ladderTags(groupBrackets([entry, stop, target], [position(-2, 5812)], [], ids), 0.25);
    const of = (role: string) => tags.find((x) => x.role === role)!;
    expect(tagTitle({ ...of('entry'), ahead: 58 })).toBe('Your buy limit 1 · 58 ahead of it');
    expect(tagTitle(of('stop'))).toBe('Your stop · 1 · placed once the entry fills');
    expect(tagTitle(of('target'))).toBe('Your target · 1 · placed once the entry fills');
    expect(tagTitle(of('position'))).toBe('Your short 2, its average price');
  });

  it('marks your orders above and below the ladder at its edges, nearest first, with the last price; not another account’s', () => {
    const entry = order({ side: 'buy', type: 'limit', price: 5810, qty: 1 });
    const stop = order({
      side: 'sell',
      type: 'stop',
      price: 5800,
      role: 'stop_loss',
      parent: entry.id,
      status: 'held',
    });
    const target = order({
      side: 'sell',
      type: 'limit',
      price: 5830,
      role: 'take_profit',
      parent: entry.id,
      status: 'held',
    });
    const far = order({ side: 'sell', type: 'limit', price: 5840, qty: 2 });
    const tags = ladderTags(groupBrackets([entry, stop, target, far], [], [], ids), 0.25);
    const w = centredOn(t(5812), 1, 21, 0);
    const price = (tick: number) => grid.toPrice(tick).toFixed(2);
    const marks = edgeMarks(w, t(5812), tags, price);
    expect(marks.map((m) => [m.where, m.text])).toEqual([
      ['below', 'SL 5800.00'],
      ['above', 'TP 5830.00'],
      ['above', 'Sell 2 5840.00'],
    ]);
    expect(marks.find((m) => m.role === 'stop')).toMatchObject({
      tick: t(5800),
      label: 'Your stop · 1 · placed once the entry fills, at 5800.00: show it',
    });
    expect(edgeMarks(centredOn(t(5830), 1, 21, 0), t(5812), tags, price)[0]).toMatchObject({
      key: 'last',
      where: 'below',
      text: '5812.00',
      label: 'Last price 5812.00: centre',
    });
    const theirs = ladderTags(groupBrackets([far], [], [], ids), 0.25).map((x) => ({
      ...x,
      key: `paper-2:${x.key}`,
      orders: [],
      account: { id: 'paper-2', name: 'Paper 2' },
    }));
    expect(edgeMarks(w, t(5812), theirs, price).map((m) => m.key)).toEqual([]);
  });

  it('a short reads with a true minus; the analyst draft is aqua and sends nothing', () => {
    const tags = ladderTags(groupBrackets([], [position(-2, 5812)], [], ids), 0.25);
    expect(tagWords(tags[0]!)).toBe('−2');
    expect(tags[0]!.side).toBe('sell');
  });

  it('shows the analyst draft as aqua tags that hold no orders, its stop on the closing side', () => {
    const draft = {
      draftId: 'd1',
      approvalId: 'a1',
      tool: 'orders.submit',
      account: 'paper-main',
      environment: 'paper',
      instrument: ES,
      preview: {
        request: {
          accountId: 'paper-main',
          instrument: ES,
          side: 'buy',
          qty: 3,
          orderType: 'limit',
          limitPrice: 5810.5,
          stopPrice: null,
          bracket: { stopLoss: 5806, takeProfit: null },
        },
        estPrice: null,
        referencePrice: 5812,
      },
      live: true,
      status: 'pending',
      origin: 'agent',
      createdAt: 0,
      staleAt: 0,
      error: null,
    } as unknown as DraftInfo;
    const tags = ladderTags(groupBrackets([], [], [draft], ids), 0.25);
    expect(tags.map((x) => [x.role, x.side, x.state, x.qty, x.orders.length])).toEqual([
      ['entry', 'buy', 'draft', 3, 0],
      ['stop', 'sell', 'draft', 3, 0],
    ]);
    expect(tags[0]!.draftId).toBe('d1');
  });

  it('joins orders of one kind and state at one row into one tag, contracts summed', () => {
    const a = order({ side: 'buy', type: 'limit', price: 5811, qty: 2 });
    const b = order({ side: 'buy', type: 'limit', price: 5811, qty: 3 });
    const tags = ladderTags(groupBrackets([a, b], [], [], ids), 0.25);
    const joined = joinTags(tags);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ qty: 5, side: 'buy' });
    expect(joined[0]!.orders).toHaveLength(2);
    const rows = ladderRows(frame({ tags }));
    const r = rows.find((x) => x.low === t(5811))!;
    expect(r.bidTags).toHaveLength(1);
    expect(r.askTags).toHaveLength(0);
  });

  it('marks the row of the position average', () => {
    const rows = ladderRows(frame({ average: t(5811.5) }));
    expect(rows.filter((r) => r.average).map((r) => r.low)).toEqual([t(5811.5)]);
  });
});

describe('what a hover says', () => {
  it('names the order a click sends, with a true minus in money', () => {
    expect(verbWords('buy', 'limit', 2, 5812.25, 2)).toBe('Buy limit 2 · 5,812.25');
    expect(verbWords('sell', 'stop', null, 5810, 2)).toBe('Sell stop · 5,810.00');
    expect(ocoWords(12, 24, 12.5, 1)).toBe('−$150.00 stop · +$300.00 target');
    expect(ocoWords(null, 8, 5, 2)).toBe('+$80.00 target');
    expect(ocoWords(null, null, 5, 2)).toBeNull();
    expect(ocoWords(12, 24, 12.5, 1, true)).toBe('−$150.00 · +$300.00');
    expect(ocoWords(null, 8, 5, 2, true)).toBe('+$80.00');
  });

  it('measures P&L at a price for a long and a short', () => {
    expect(pnlAt({ side: 'buy', qty: 2, average: 5810 }, 5812.25, 50)).toBeCloseTo(225);
    expect(pnlAt({ side: 'sell', qty: 1, average: 5810 }, 5812, 50)).toBeCloseTo(-100);
    expect(pnlAt(null, 5812, 50)).toBeNull();
  });

  it('writes sizes whole and grouped, thousands from ten thousand', () => {
    expect(sizeWords(0)).toBe('');
    expect(sizeWords(1234)).toBe('1,234');
    expect(sizeWords(12_400)).toBe('12.4k');
    expect(sizeWords(240_000)).toBe('240k');
    expect(sizeWords(999)).toBe('999');
    expect(sizeWords(2.5)).toBe('2.5');
  });
});

describe('the feed and the strip', () => {
  const live = book([[5812, 10]], [[5812.25, 8]], 1000);

  it('is live while heard, stale after 2 s or on a gap, reading before the first book, and names a drop', () => {
    const o = { error: null, dropped: null };
    expect(feedState(live, 2500, o)).toEqual({ kind: 'live' });
    expect(feedState(live, 3200, o)).toEqual({ kind: 'stale', behindMs: 2200, resyncing: false });
    expect(feedState({ seq: null, gapPending: false, heard: 0 }, 900, o)).toEqual({ kind: 'reading' });
    expect(feedState({ seq: 4, gapPending: true, heard: 1000 }, 1100, o)).toMatchObject({
      kind: 'stale',
      resyncing: true,
    });
    expect(feedState(live, 1500, { ...o, dropped: 'Rithmic down: connection lost' })).toEqual({
      kind: 'dropped',
      words: 'Rithmic down: connection lost',
    });
    expect(feedState(live, 1500, { ...o, error: 'Paper offers no depth for ES' })).toEqual({ kind: 'nobook' });
    expect(entriesOpen({ kind: 'live' })).toBe(true);
    expect(entriesOpen({ kind: 'stale', behindMs: 2400, resyncing: false })).toBe(false);
  });

  it('is closed with the market, whatever the book says, unless the connection itself dropped', () => {
    const o = { error: null, dropped: null, closed: 'Closed · opens Sun 18:00 ET' };
    const closed: FeedState = { kind: 'closed', words: 'Closed · opens Sun 18:00 ET' };
    expect(feedState(live, 2500, o)).toEqual(closed);
    expect(feedState(live, 600_000, o), 'a closed book is not behind').toEqual(closed);
    expect(feedState({ seq: null, gapPending: false, heard: 0 }, 900, o), 'nor still reading').toEqual(closed);
    expect(feedState(live, 1500, { ...o, dropped: 'Rithmic: connection lost.' })).toMatchObject({ kind: 'dropped' });
    expect(entriesOpen(closed)).toBe(false);
    expect(stripFor({ ...base, feed: closed })?.left).toBe('Closed · opens Sun 18:00 ET');
  });

  it('takes the drop words from the link, else the book connection when it is down', () => {
    const up = { status: 'open' as const, everConnected: true, attempt: 0 };
    const down = { status: 'reconnecting' as const, everConnected: true, attempt: 3 };
    const rithmic = {
      providerId: 'rithmic',
      kind: 'market_data' as const,
      displayName: 'Rithmic',
      status: 'down' as const,
      latencyMs: null,
      lastMessageAt: null,
      message: 'connection lost',
      checkedAt: 0,
    };
    expect(droppedWords(down, [], null)).toBe('Runtime dropped. Reconnecting, 3rd try.');
    expect(droppedWords(up, [rithmic], 'rithmic')).toBe('Rithmic: connection lost.');
    expect(droppedWords(up, [rithmic], 'paper')).toBeNull();
    expect(droppedWords(up, [{ ...rithmic, status: 'ok' }], 'rithmic')).toBeNull();
  });

  const base: StripInput = {
    now: 10_000,
    placing: null,
    flash: null,
    feed: { kind: 'live' },
    account: { kind: 'open', offPaper: false },
    hover: null,
    decimals: 2,
  };
  const hover = {
    side: 'buy' as const,
    price: 5812.25,
    kind: 'limit' as const,
    qty: 2,
    risk: null,
    refusal: null,
    pnl: null,
    oco: '−$150.00 stop · +$300.00 target',
  };

  it('says nothing while there is nothing to say', () => {
    expect(stripFor(base)).toBeNull();
    expect(stripFor({ ...base, feed: { kind: 'reading' } })).toBeNull();
  });

  it('on a trade cell: the verb, then the OCO, the P&L at the price instead with a position, brass off paper', () => {
    expect(stripFor({ ...base, hover })).toMatchObject({
      left: 'Buy limit 2 · 5,812.25',
      right: '−$150.00 stop · +$300.00 target',
      tone: 'plain',
    });
    expect(stripFor({ ...base, hover: { ...hover, pnl: 225 } })).toMatchObject({ right: '+$225.00', rightTone: 'up' });
    expect(stripFor({ ...base, hover: { ...hover, pnl: -50 } })).toMatchObject({ right: '−$50.00', rightTone: 'down' });
    expect(stripFor({ ...base, account: { kind: 'open', offPaper: true }, hover })?.tone).toBe('plain');
    expect(stripFor({ ...base, hover: { ...hover, refusal: 'fills at once' } })).toMatchObject({
      right: 'fills at once',
      rightTone: 'err',
    });
    expect(stripFor({ ...base, hover: { ...hover, qty: null, risk: 250 } })?.right).toBe('$250.00 risk');
  });

  it('names the account a click sends for when several can trade, and has the OCO’s money alone for a narrow ladder', () => {
    const narrow = stripFor({ ...base, who: 'Eval 50K', hover: { ...hover, ocoShort: '−$150.00 · +$300.00' } });
    expect(narrow).toMatchObject({
      left: 'Buy limit 2 · 5,812.25',
      who: 'Eval 50K',
      right: '−$150.00 stop · +$300.00 target',
      rightShort: '−$150.00 · +$300.00',
    });
    expect(stripFor({ ...base, hover })?.who).toBeNull();
    expect(
      stripFor({ ...base, who: 'Paper', hover: { ...hover, pnl: 225, ocoShort: '−$150.00 · +$300.00' } }),
    ).toMatchObject({ who: 'Paper', right: '+$225.00', rightShort: null });
  });

  it('stale, dropped and no book outrank the hover; a refusal outranks them all for its few seconds', () => {
    expect(stripFor({ ...base, hover, feed: { kind: 'stale', behindMs: 2400, resyncing: false } })?.left).toBe(
      'Book 2.4 s behind',
    );
    expect(
      stripFor({ ...base, hover, feed: { kind: 'dropped', words: 'Rithmic dropped. Reconnecting, 3rd try.' } })?.left,
    ).toBe('Rithmic dropped. Reconnecting, 3rd try.');
    expect(stripFor({ ...base, feed: { kind: 'nobook' } })).toMatchObject({
      left: 'This connection has no order book',
      action: { label: 'Connections', section: 'connections' },
    });
    expect(
      stripFor({ ...base, hover, feed: { kind: 'nobook' }, flash: { text: 'Price moved; nothing sent', tone: 'err' } }),
    ).toMatchObject({ left: 'Price moved; nothing sent', tone: 'err' });
  });

  it('a placement under way shows its hint, and why the next click would be refused', () => {
    expect(
      stripFor({
        ...base,
        hover,
        placing: { hint: 'Click the stop: $250.00 at risk sizes it · Esc cancels', error: null },
      }),
    ).toMatchObject({ left: 'Click the stop: $250.00 at risk sizes it · Esc cancels', right: null });
    expect(stripFor({ ...base, placing: { hint: 'Click the stop', error: 'Stop above the entry' } })).toMatchObject({
      right: 'Stop above the entry',
      rightTone: 'err',
    });
  });

  it('without an account or on one Tessera only reads: why, and the P&L read-out at the price', () => {
    expect(stripFor({ ...base, account: { kind: 'none' }, hover })).toMatchObject({
      left: 'Choose an account',
      action: { label: 'Accounts' },
    });
    const why = "Tessera reads this Apex account; orders are placed on the firm's own platform.";
    expect(readOnlyWords(why)).toBe('Tessera reads this Apex account');
    const s = stripFor({ ...base, account: { kind: 'readonly', why }, hover: { ...hover, pnl: 125 } })!;
    expect(s).toMatchObject({ left: 'Tessera reads this Apex account', right: '+$125.00', tone: 'plain' });
    expect(s.left).not.toMatch(/Buy/);
  });
});

describe('the press rule', () => {
  const at = { row: 4, cell: 'bid' as const, tick: t(5812), gen: 7 };
  const open = { ok: true } as const;

  it('sends once when down and up land on the same cell of the same row, at the same price', () => {
    const g = new PressGate();
    const id = g.down(at);
    expect(g.current).toEqual(at);
    expect(g.up(id, at, open)).toEqual({ send: true });
    expect(g.up(id, at, open)).toBeNull();
    expect(g.current).toBeNull();
  });

  it('sends nothing when released on another row or cell, after a recentre, or on a stale book', () => {
    const g = new PressGate();
    expect(g.up(g.down(at), { ...at, row: 5 }, open)).toEqual({
      send: false,
      why: 'Released off the row; nothing sent',
    });
    expect(g.up(g.down(at), { ...at, cell: 'ask' }, open)).toMatchObject({ send: false });
    expect(g.up(g.down(at), null, open)).toMatchObject({ send: false });
    expect(g.up(g.down(at), { ...at, gen: 8 }, open)).toEqual({ send: false, why: 'Price moved; nothing sent' });
    expect(g.up(g.down(at), { ...at, tick: at.tick + 1 }, open)).toEqual({
      send: false,
      why: 'Price moved; nothing sent',
    });
    expect(g.up(g.down(at), at, { ok: false, why: 'Book stale' })).toEqual({
      send: false,
      why: 'Book stale; nothing sent',
    });
  });

  it('an older press id never sends after a newer press began', () => {
    const g = new PressGate();
    const first = g.down(at);
    const second = g.down({ ...at, row: 6 });
    expect(g.up(first, at, open)).toBeNull();
    expect(g.up(second, { ...at, row: 6 }, open)).toEqual({ send: true });
  });
});

const q: PlaceQuote = { bid: 5812, ask: 5812.25, last: 5812 };
const account = (env: 'paper' | 'eval' = 'paper', locked = false): AccountUpdate =>
  ({
    account: { id: 'paper-main', environment: env, displayName: 'Paper', connectionId: 'paper' },
    summary: { netLiq: { amount: 50_000, currency: 'USD' } },
    risk: null,
    ...(locked ? { limits: { locked: true, dailyLossLimit: { amount: 500 }, dailyLossLeft: { amount: 0 } } } : {}),
  }) as unknown as AccountUpdate;

const setup = (over: Partial<DomTradeSetup> = {}): DomTradeSetup => ({
  account: account(),
  gate: { kind: 'open', offPaper: false },
  instrument: ES,
  ids: new Set([ES]),
  symbol: 'ES Z6',
  math: { tick: 0.25, tickValue: 12.5, decimals: 2 },
  ticket: { qty: 2, sizing: 'qty', risk: 250, entry: 'market' },
  oco: {
    ...DEFAULT_OCO,
    on: true,
    stop: { on: true, unit: 'ticks', value: 12 },
    target: { on: true, unit: 'ticks', value: 24 },
  },
  scope: null,
  ...over,
});

describe('DOM trading (the chart placement, nothing new)', () => {
  it('starts from the workspace account and the ticket, or says why nothing can be placed', () => {
    const b = placeBaseFor(setup());
    expect('base' in b && b.base).toMatchObject({
      accountId: 'paper-main',
      qty: 2,
      stopTicks: 12,
      targetTicks: 24,
      mode: 'qty',
    });
    expect(placeBaseFor(setup({ account: null, gate: { kind: 'none' } }))).toEqual({ why: 'Choose an account' });
    expect(placeBaseFor(setup({ gate: { kind: 'readonly', why: 'Tessera reads this Apex account' } }))).toEqual({
      why: 'Tessera reads this Apex account',
    });
    expect(placeBaseFor(setup({ account: account('paper', true) }))).toEqual({
      why: 'Daily loss limit reached · exits work',
    });
    const ev = placeBaseFor(setup({ account: account('eval'), oco: { ...DEFAULT_OCO, on: false } }));
    expect('base' in ev && ev.base.stopTicks).toBeNull();
  });

  it('a cell places the ticket’s limit or stop as picked; at market the ladder’s convention', () => {
    const at = (entry: 'market' | 'limit' | 'stop', price: number) =>
      cellKind(setup({ ticket: { qty: 1, sizing: 'qty', risk: 250, entry } }), 'buy', price, q);
    expect(at('market', 5811.5)).toBe('limit');
    expect(at('market', 5813)).toBe('stop');
    expect(at('limit', 5813)).toBe('limit');
    expect(at('stop', 5811.5)).toBe('stop');
    const b = placeBaseFor(setup({ ticket: { qty: 2, sizing: 'qty', risk: 250, entry: 'limit' } }));
    if (!('base' in b)) throw new Error('no base');
    const c = clickAt(null, { ...b.base, side: 'buy', kind: 'limit' }, 5814, q, false)!;
    expect(c.step.kind).toBe('send');
    if (c.step.kind !== 'send') return;
    expect(c.step.input).toMatchObject({ orderType: 'limit', limitPrice: 5812.25 });
    expect(c.step.input.bracket).toEqual({ stopLoss: null, takeProfit: null, stopTicks: 12, targetTicks: 24 });
  });

  it('clickAt: a bid cell under the ask sends a buy limit with the OCO, at the ask a buy stop is refused', () => {
    const b = placeBaseFor(setup());
    if (!('base' in b)) throw new Error('no base');
    const c = clickAt(null, { ...b.base, side: 'buy', kind: cellKind(setup(), 'buy', 5811.5, q) }, 5811.5, q, false)!;
    expect(c.fresh).toBe(true);
    expect(c.step.kind).toBe('send');
    if (c.step.kind !== 'send') return;
    expect(c.step.input).toMatchObject({ side: 'buy', qty: 2, orderType: 'limit', limitPrice: 5811.5 });
    expect(c.step.input.bracket).toEqual({ stopLoss: 5808.5, takeProfit: 5817.5 });
    const refused = clickAt(
      null,
      { ...b.base, side: 'buy', kind: cellKind(setup(), 'buy', 5812.25, q) },
      5812.25,
      q,
      false,
    )!;
    expect(refused.step.kind).toBe('error');
    expect(refused.step.next?.error).toMatch(/trigger at once/);
  });

  it('clickAt: by risk the first click is the entry and the next (on the DOM or the chart) its stop', () => {
    const b = placeBaseFor(setup({ ticket: { qty: 1, sizing: 'risk', risk: 250, entry: 'market' } }));
    if (!('base' in b)) throw new Error('no base');
    const first = clickAt(null, { ...b.base, side: 'sell', kind: cellKind(setup(), 'sell', 5813, q) }, 5813, q, false)!;
    expect(first.step.kind).toBe('next');
    const p = first.step.next!;
    expect(p.stage).toBe('stop');
    const second = clickAt(p, null, 5815, q, false)!;
    expect(second.fresh).toBe(false);
    expect(second.step.kind).toBe('send');
    if (second.step.kind !== 'send') return;
    expect(second.step.input).toMatchObject({ side: 'sell', qty: 2, orderType: 'limit', limitPrice: 5813 });
    expect(second.step.input.bracket?.stopLoss).toBe(5815);
  });

  it('the chart click is unchanged: with a placement the click is its step, without one nothing happens', () => {
    const base: PlaceBase = { ...(placeBaseFor(setup()) as { base: PlaceBase }).base, kind: 'limit' };
    const p = beginPlacement(base);
    expect(clickAt(p, null, 5811, q, false)).toEqual({ placement: p, step: placeAt(p, 5811, q, false), fresh: false });
    expect(clickAt(null, null, 5811, q, false)).toBeNull();
  });

  it('a trade cell continues a placement waiting for its stop, never one still waiting for its entry', () => {
    const b = (placeBaseFor(setup()) as { base: PlaceBase }).base;
    const waiting = beginPlacement({ ...b, side: 'sell', kind: 'limit' });
    const ids = new Set([ES]);
    expect(continuing(waiting, 'paper-main', ids)).toBeNull();
    const stop = { ...waiting, stage: 'stop' as const, entry: 5813 };
    expect(continuing(stop, 'paper-main', ids)).toBe(stop);
    expect(continuing(stop, 'other', ids)).toBeNull();
    expect(continuing(stop, 'paper-main', new Set(['NQZ6.CME']))).toBeNull();
  });

  it('shares one placement with the chart it follows, never with another chart', () => {
    const at = { layoutId: 'default', tileId: 'chart-1' };
    const b = placeBaseFor(setup({ scope: at }));
    if (!('base' in b)) throw new Error('no base');
    expect(b.base).toMatchObject(at);
    expect(placementFor(beginPlacement({ ...b.base, kind: 'limit' }), 'paper-main', new Set([ES]), at)).not.toBeNull();
    expect(
      placementFor(beginPlacement({ ...b.base, kind: 'limit' }), 'paper-main', new Set([ES]), {
        ...at,
        tileId: 'chart-2',
      }),
    ).toBeNull();
    const stop = { ...beginPlacement({ ...b.base, side: 'sell', kind: 'limit' }), stage: 'stop' as const, entry: 5813 };
    const ids = new Set([ES]);
    expect(continuing(stop, 'paper-main', ids, at)).toBe(stop);
    expect(continuing(stop, 'paper-main', ids, { ...at, tileId: 'chart-2' })).toBeNull();
    expect(continuing(stop, 'paper-main', ids, { ...at, layoutId: 'scalp' })).toBeNull();
    expect(placementFor(stop, 'paper-main', ids, null)).toBeNull();
    const loose = { ...stop, tileId: undefined, layoutId: undefined };
    expect(continuing(loose, 'paper-main', ids, at)).toBe(loose);
    expect(placementFor(loose, 'paper-main', ids, null)).toBe(loose);
  });

  it('takes the chart’s placement under any id it knows its instrument by, as the chart does', () => {
    const at = { layoutId: 'default', tileId: 'chart-1' };
    const b = (placeBaseFor(setup({ scope: at })) as { base: PlaceBase }).base;
    const stop = { ...beginPlacement({ ...b, side: 'sell', kind: 'limit' }), stage: 'stop' as const, entry: 5813 };
    expect(continuing(stop, 'paper-main', new Set(['ES', ES]), at)).toBe(stop);
    expect(continuing(stop, 'paper-main', new Set(['ES']), at)).toBeNull();
  });

  it('the row menu words its entries for what a pick sends', () => {
    const row = { buy: 5811.5, sell: 5811.5 };
    expect(menuTrades(row, setup(), q, true)).toEqual([
      { side: 'buy', price: 5811.5, word: 'Buy limit 2 at 5,811.50' },
      { side: 'sell', price: 5811.5, word: 'Sell stop 2 at 5,811.50' },
    ]);
    expect(menuTrades(row, setup(), q, false)).toEqual([]);
    expect(menuTrades(row, setup({ gate: { kind: 'readonly', why: 'Tessera reads this account' } }), q, true)).toEqual(
      [],
    );
  });

  it('a menu pick sends nothing once a placement began on the ladder after the menu opened', async () => {
    const request = vi.fn((..._: unknown[]) => Promise.reject(new Error('the test sends nowhere')));
    setTestServices({ request });
    const b = (
      placeBaseFor(setup({ ticket: { qty: 1, sizing: 'risk', risk: 250, entry: 'market' } })) as { base: PlaceBase }
    ).base;
    const stop = { ...beginPlacement({ ...b, side: 'sell', kind: 'limit' }), stage: 'stop' as const, entry: 5813 };
    startPlacement(stop);
    const reports: unknown[] = [];
    const why = await tradeClick(setup(), 'buy', 5811.5, q, [], (r) => reports.push(r), 'entry');
    expect(why).toBe('The placement changed; nothing sent');
    expect(read(placementStore).placing).toBe(stop);
    expect(reports).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    endPlacement();
    await tradeClick(setup(), 'buy', 5811.5, q, [], (r) => reports.push(r), 'entry');
    expect(request.mock.calls.map((c) => c.slice(0, 2))).toMatchObject([
      ['tools.invoke', { name: 'orders.submit', input: { side: 'buy', limitPrice: 5811.5 } }],
    ]);
  });

  it('a hover says the kind, the refusal, the OCO in money, and P&L at the price with a position', () => {
    expect(hoverTrade(setup(), 'buy', 5811.5, q, null)).toMatchObject({
      kind: 'limit',
      qty: 2,
      refusal: null,
      oco: '−$300.00 stop · +$600.00 target',
      ocoShort: '−$300.00 · +$600.00',
    });
    expect(hoverTrade(setup(), 'buy', 5812.25, q, null).refusal).toBe('triggers at once');
    expect(hoverTrade(setup(), 'sell', 5812, q, null).refusal).toBe('triggers at once');
    expect(hoverTrade(setup(), 'sell', 5812.5, q, { side: 'buy', qty: 2, average: 5810 }).pnl).toBeCloseTo(250);
    expect(
      hoverTrade(setup({ ticket: { qty: 1, sizing: 'risk', risk: 300, entry: 'market' } }), 'buy', 5811, q, null),
    ).toMatchObject({
      qty: null,
      risk: 300,
    });
  });
});

describe('where the DOM opens', () => {
  it('takes its width from the widest charts first, levelling them', async () => {
    const { levelWidths } = await import('../src/orderflow/place.ts');
    expect(levelWidths([729, 729], 264)).toEqual([597, 597]);
    expect(levelWidths([1000, 500], 264)).toEqual([736, 500]);
    expect(levelWidths([600, 500], 264)).toEqual([418, 418]);
    expect(levelWidths([1458], 264)).toEqual([1194]);
  });
});
