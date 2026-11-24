import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { BookStore, TickGrid, TradeTape } from '@tessera/chart';
import { describe, expect, it } from 'vitest';
import { levelKey, LevelFlow, QueueEstimate, SAMPLE_MS } from '../src/orderflow/dom/ladderFlow.ts';
import {
  centredOn,
  columnClasses,
  ladderHeader,
  ladderRows,
  ladderTemplate,
  type LadderColumns,
  type LevelView,
  type VolumeView,
} from '../src/orderflow/dom/ladderModel.ts';
import { ns } from './support/time.ts';

const ES = new TickGrid(0.25, 2);
const t = (p: number) => ES.toTick(p);

function bookOf(seq: number, bids: number[][], asks: number[][], into = new BookStore(ES)): BookStore {
  into.apply({ seq, kind: 'snapshot', levels: 10, bids, asks }, 0);
  return into;
}

describe('pulling, stacking and refills', () => {
  it('reads size added or pulled per level over the window, fills excluded', () => {
    const tape = new TradeTape(ES, 64);
    tape.applySnapshot({ seq: 0, trades: [] });
    const flow = new LevelFlow(1000);
    const book = bookOf(1, [[5812, 50, 9]], [[5812.25, 40, 7]]);
    flow.syncTape(tape);
    flow.sample(book, 0);
    tape.apply({ seq: 1, trades: [[ns(100), 5812, 20, -1]] });
    flow.syncTape(tape);
    bookOf(2, [[5812, 40, 9]], [[5812.25, 10, 2]], book);
    expect(flow.sample(book, SAMPLE_MS - 1)).toBe(false);
    expect(flow.sample(book, SAMPLE_MS)).toBe(true);
    expect(flow.change('bid', t(5812), 1)).toBe(10);
    expect(flow.change('ask', t(5812.25), 1)).toBe(-30);
    tape.apply({ seq: 2, trades: [[ns(300), 5812.25, 10, 1]] });
    flow.syncTape(tape);
    bookOf(3, [[5812, 40, 9]], [[5812.5, 15, 3]], book);
    flow.sample(book, 2 * SAMPLE_MS);
    expect(flow.change('ask', t(5812.25), 1)).toBe(-30);
    flow.sample(book, 2000);
    flow.sample(book, 2000 + SAMPLE_MS);
    expect(flow.change('bid', t(5812), 1)).toBe(0);
    expect(flow.change('ask', t(5812.5), 1)).toBe(0);
  });

  it('marks a level that stood while its side traded more there than it ever showed', () => {
    const tape = new TradeTape(ES, 64);
    tape.applySnapshot({ seq: 0, trades: [] });
    const flow = new LevelFlow(10_000);
    const book = bookOf(1, [[5812, 5, 1]], [[5812.25, 30, 4]]);
    flow.syncTape(tape);
    flow.sample(book, 0);
    let seq = 0;
    for (let k = 1; k <= 4; k++) {
      tape.apply({ seq: ++seq, trades: [[ns(k * SAMPLE_MS - 10), 5812, 5, -1]] });
      flow.syncTape(tape);
      bookOf(k + 1, [[5812, 5, 1]], [[5812.25, 30, 4]], book);
      flow.sample(book, k * SAMPLE_MS);
    }
    expect(flow.refilled('bid', t(5812), 1)).toBe(4);
    expect(flow.refilled('ask', t(5812.25), 1)).toBe(0);
    bookOf(9, [[5811.75, 5, 1]], [[5812.25, 30, 4]], book);
    flow.sample(book, 5 * SAMPLE_MS);
    expect(flow.refilled('bid', t(5812), 1)).toBe(0);
    expect(flow.tradedInto('bid', t(5812))).toBe(20);
    expect(levelKey('bid', 3)).toBe(7);
  });
});

describe('queue position', () => {
  it('starts behind what rested, works off with what trades there, never more than the level shows', () => {
    const tape = new TradeTape(ES, 64);
    tape.applySnapshot({ seq: 0, trades: [] });
    const flow = new LevelFlow();
    const q = new QueueEstimate();
    const book = bookOf(1, [[5812, 42, 9]], [[5812.25, 30, 4]]);
    const mine = { id: 'o1', side: 'buy' as const, tick: t(5812), qty: 2, brokerAhead: null };
    q.update([mine], book, flow);
    expect(q.ahead(mine)).toBe(40);
    tape.apply({ seq: 1, trades: [[ns(10), 5812, 15, -1]] });
    flow.syncTape(tape);
    bookOf(2, [[5812, 27, 6]], [[5812.25, 30, 4]], book);
    q.update([mine], book, flow);
    expect(q.ahead(mine)).toBe(25);
    bookOf(3, [[5812, 12, 3]], [[5812.25, 30, 4]], book);
    q.update([mine], book, flow);
    expect(q.ahead(mine)).toBe(10);
    expect(q.ahead({ id: 'o1', brokerAhead: 3 })).toBe(3);
    q.update([{ ...mine, tick: t(5811.75) }], book, flow);
    expect(q.ahead(mine)).toBe(0);
    q.update([], book, flow);
    expect(q.ahead(mine)).toBeNull();
  });
});

describe('the ladder’s optional columns', () => {
  it('lays out only the columns that show', () => {
    const all = { pnl: true, pullStack: true, traded: true, volume: true, nobook: false, orders: true };
    expect(ladderTemplate(all).split(' minmax').length).toBeGreaterThan(5);
    expect(ladderTemplate({ ...all, pnl: false, pullStack: false, traded: false })).toBe(
      'minmax(72px, 1fr) var(--lad-px) minmax(72px, 1fr) minmax(42px, 0.7fr)',
    );
    expect(ladderTemplate({ ...all, pnl: false, pullStack: false, traded: false, volume: false, nobook: true })).toBe(
      '0 minmax(var(--lad-px), 1fr) 0',
    );
    expect(columnClasses({ ...all, nobook: true })).toEqual({
      'has-pnl': true,
      'has-ps': false,
      'has-ord': false,
      'has-traded': true,
    });
  });

  it('labels every column it lays out, in the same order, for any mix of columns', () => {
    const tracks = (template: string) => {
      let depth = 0;
      let n = 1;
      for (const ch of template) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ' ' && depth === 0) n++;
      }
      return n;
    };
    for (let m = 0; m < 64; m++) {
      const c: LadderColumns = {
        pnl: !!(m & 1),
        pullStack: !!(m & 2),
        traded: !!(m & 4),
        volume: !!(m & 8),
        nobook: !!(m & 16),
        orders: !!(m & 32),
      };
      expect(ladderHeader(c, { volumeColumn: 'session', refills: true })).toHaveLength(tracks(ladderTemplate(c)));
    }
    const all = { pnl: true, pullStack: true, traded: true, volume: true, nobook: false, orders: true };
    expect(ladderHeader(all, { volumeColumn: 'session', refills: true }).flatMap((h) => h.labels)).toEqual([
      'P&L',
      '±',
      'Sold',
      'Orders',
      'Bid',
      'Price',
      'Ask',
      'Orders',
      'Bought',
      '±',
      'Vol',
    ]);
    expect(
      ladderHeader({ ...all, nobook: true }, { volumeColumn: 'session', refills: true }).flatMap((h) => h.labels),
    ).toEqual(['P&L', 'Sold', 'Price', 'Bought', 'Vol']);
  });

  it('says what both numbers on a side are, and leaves orders out when they are off', () => {
    const plain = { pnl: false, pullStack: false, traded: false, volume: true, nobook: false };
    const word = (orders: boolean, volumeColumn: 'session' | 'recent') =>
      Object.fromEntries(
        ladderHeader({ ...plain, orders }, { volumeColumn, refills: true }).map((h) => [h.column, h.word]),
      );
    expect(word(true, 'session')).toMatchObject({
      bid: 'Contracts bid at each price and, beside them, how many orders hold them · an inner edge: refilled as it traded · click to buy',
      ask: 'Contracts offered at each price and, beside them, how many orders hold them · an inner edge: refilled as it traded · click to sell',
      vol: 'Volume this session',
    });
    expect(word(false, 'recent')).toMatchObject({
      bid: 'Contracts bid at each price · an inner edge: refilled as it traded · click to buy',
      ask: 'Contracts offered at each price · an inner edge: refilled as it traded · click to sell',
      vol: 'Volume, last minute · buys · sells',
    });
  });

  it('shows and explains nothing over a book that has no depth', () => {
    const all = { pnl: false, pullStack: false, traded: false, volume: true, nobook: true, orders: true };
    const book = ladderHeader(all, { volumeColumn: 'session', refills: true }).filter(
      (h) => h.column === 'bid' || h.column === 'ask',
    );
    expect(book.map((h) => [h.labels, h.word])).toEqual([
      [[], ''],
      [[], ''],
    ]);
  });

  it('mentions the refill edge only while refills show', () => {
    const plain = { pnl: false, pullStack: false, traded: false, volume: true, nobook: false, orders: true };
    const words = (refills: boolean) =>
      ladderHeader(plain, { volumeColumn: 'session', refills })
        .filter((h) => h.column === 'bid' || h.column === 'ask')
        .map((h) => h.word);
    expect(words(true).every((w) => w.includes('an inner edge: refilled as it traded'))).toBe(true);
    expect(words(false)).toEqual([
      'Contracts bid at each price and, beside them, how many orders hold them · click to buy',
      'Contracts offered at each price and, beside them, how many orders hold them · click to sell',
    ]);
  });

  it('fits every label in its column at the column’s narrowest, in the header’s face', () => {
    GlobalFonts.registerFromPath(
      join(import.meta.dirname, '../../../packages/ui/fonts/InstrumentSans-VF.woff2'),
      'Instrument Sans',
    );
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = "400 11.5px 'Instrument Sans'";
    const all = { pnl: true, pullStack: true, traded: true, volume: true, nobook: false, orders: true };
    const narrowest = ladderTemplate(all)
      .split(/ (?![^(]*\))/)
      .map((track) => (track.startsWith('var(') ? 80 : Number(/(\d+)px/.exec(track)![1])));
    const cells = ladderHeader(all, { volumeColumn: 'session', refills: true });
    cells.forEach((cell, k) => {
      const padding = cell.column === 'bid' || cell.column === 'ask' ? 4 + 6 : 4 + 4;
      const text = cell.labels.reduce((w, l) => w + ctx.measureText(l).width, 0) + 4 * (cell.labels.length - 1);
      expect(text + padding, cell.labels.join(' ')).toBeLessThanOrEqual(narrowest[k]!);
    });
  });

  it('fills each row with what was measured at its price', () => {
    const book = bookOf(1, [[5812, 50, 9]], [[5812.25, 40, 7]]);
    const traded: VolumeView = {
      poc: null,
      at: (low, _rt, out) => {
        const o = out ?? { total: 0, buy: 0, sell: 0 };
        o.sell = low === t(5812) ? 120 : 0;
        o.buy = low === t(5812.25) ? 80 : 0;
        o.total = o.sell + o.buy;
        return o;
      },
    };
    const levels: LevelView = {
      change: (side, low) => (side === 'bid' && low === t(5812) ? -15 : 0),
      refilled: (side, low) => (side === 'ask' && low === t(5812.25) ? 3 : 0),
    };
    const w = centredOn(t(5812), 1, 5, 0);
    const rows = ladderRows({
      window: w,
      count: 5,
      book,
      last: t(5812.25),
      volume: null,
      tags: [],
      average: t(5811.5),
      pnlSide: 'buy',
      traded,
      levels,
      orderCounts: true,
      lastTrade: { size: 7, side: 1 },
      toPrice: (k) => ES.toPrice(k),
      decimals: 2,
      tick: 0.25,
    });
    const bid = rows.find((r) => r.low === t(5812))!;
    const ask = rows.find((r) => r.low === t(5812.25))!;
    expect([bid.bidOrders, bid.sold, bid.bidChange, bid.pnl]).toEqual([9, 120, -15, 2]);
    expect([ask.askOrders, ask.bought, ask.askRefills, ask.lastSize, ask.lastSide, ask.pnl]).toEqual([
      7, 80, 3, 7, 1, 3,
    ]);
    expect(bid.lastSize).toBe(0);
    const plain = ladderRows({
      window: w,
      count: 5,
      book,
      last: null,
      volume: null,
      tags: [],
      average: null,
      toPrice: (k) => ES.toPrice(k),
      decimals: 2,
      tick: 0.25,
    });
    expect(plain.every((r) => r.bidOrders === -1 && r.pnl === null && r.sold === 0)).toBe(true);
  });
});

describe('columns that fit', () => {
  it('drops what does not fit, least needed first; the book and the price stay', async () => {
    const { fitColumns } = await import('../src/orderflow/dom/ladderModel.ts');
    const all = { pnl: true, pullStack: true, traded: true, volume: true, nobook: false, orders: true };
    expect(fitColumns(all, 480, 100)).toEqual(all);
    expect(fitColumns(all, 380, 100)).toEqual({ ...all, volume: false, pullStack: false });
    expect(fitColumns(all, 330, 100)).toEqual({ ...all, pullStack: false, traded: false });
    expect(fitColumns(all, 280, 100)).toEqual({ ...all, volume: false, pullStack: false, traded: false });
    expect(fitColumns(all, 240, 100)).toEqual({
      ...all,
      volume: false,
      pullStack: false,
      traded: false,
      orders: false,
    });
    expect(fitColumns(all, 200, 100)).toEqual({
      ...all,
      volume: false,
      pullStack: false,
      traded: false,
      orders: false,
      pnl: false,
    });
    const plain = { pnl: false, pullStack: false, traded: false, volume: true, nobook: false, orders: true };
    expect(fitColumns(plain, 300, 100)).toEqual(plain);
  });

  it('keeps Bid, Price and Ask at the narrowest DOM by dropping the order counts first', async () => {
    const { fitColumns, LADDER_MIN_WIDTH, priceColumnWidth } = await import('../src/orderflow/dom/ladderModel.ts');
    const asked = { pnl: false, pullStack: false, traded: false, volume: true, nobook: false, orders: true };
    for (const price of ['20,641.25', '104,512.50']) {
      const fit = fitColumns(asked, LADDER_MIN_WIDTH, priceColumnWidth(price.length));
      expect(fit, price).toEqual({ ...asked, volume: false, orders: false });
      expect(ladderHeader(fit, { volumeColumn: 'session', refills: false }).flatMap((h) => h.labels)).toEqual([
        'Bid',
        'Price',
        'Ask',
      ]);
      expect(columnClasses(fit)['has-ord']).toBe(false);
    }
    expect(ladderTemplate({ ...asked, volume: false, orders: false })).toBe(
      'minmax(48px, 1fr) var(--lad-px) minmax(48px, 1fr)',
    );
    expect(fitColumns(asked, 260, priceColumnWidth(9))).toEqual({ ...asked, volume: false });
  });
});
