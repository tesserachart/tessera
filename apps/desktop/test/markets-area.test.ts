import type { Instrument, Quote } from '@tessera/protocol';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  clickSelection,
  contractMonth,
  filterRows,
  flatRows,
  listedCount,
  matchesQuery,
  movingSection,
  productName,
  rowsOf,
  sectionsOf,
  sortSections,
  symbolRows,
  type ConnectionListing,
  type MarketRow,
} from '../src/areas/markets/model.ts';
import { DEFAULT_PLACE, placeView, readPlace } from '../src/areas/markets/store.ts';
import { quoteStore } from '../src/market/quotes.ts';
import { useSortQuotes } from '../src/markets/rowData.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { pause } from './support/pause.ts';

const fut = (
  root: string,
  month: string,
  expiry: string,
  front = false,
  exchange = 'CME',
  name = root,
): Instrument => ({
  id: `${root}${month}.${exchange}`,
  symbol: `${root}${month}`,
  name: `${name} ${contractMonth({ symbol: `${root}${month}`, root, expiry })!}`,
  assetClass: 'future',
  exchange,
  currency: 'USD',
  root,
  expiry,
  isFront: front,
  tradable: true,
});

const apex: ConnectionListing = {
  id: 'rithmic-apex',
  name: 'Apex · Rithmic',
  feedsDesk: false,
  error: null,
  instruments: [
    fut('NQ', 'H7', '2027-03-19', false, 'CME', 'E-mini Nasdaq-100'),
    fut('NQ', 'Z6', '2026-12-18', true, 'CME', 'E-mini Nasdaq-100'),
    fut('ES', 'Z6', '2026-12-18', true, 'CME', 'E-mini S&P 500'),
    fut('MNQ', 'Z6', '2026-12-18', true, 'CME', 'Micro E-mini Nasdaq-100'),
    fut('GC', 'Z6', '2026-12-29', true, 'COMEX', 'Gold'),
    fut('CL', 'X6', '2026-10-20', true, 'NYMEX', 'Crude Oil'),
  ],
};
const real: ConnectionListing = {
  id: 'rithmic',
  name: 'Rithmic',
  feedsDesk: true,
  error: null,
  instruments: [fut('NQ', 'Z6', '2026-12-18', true, 'CME', 'E-mini Nasdaq-100')],
};

const quote = (instrument: string, last: number | null, prev: number | null, volume = 0): Quote => ({
  instrument,
  ts: 0,
  bid: null,
  bidSize: null,
  ask: null,
  askSize: null,
  last,
  lastSize: null,
  session: { tradeDate: '2026-10-09', open: null, high: null, low: null, prevClose: prev, volume },
  source: null,
});

describe('the Markets area: what each connection lists, by exchange and root', () => {
  it('reads contracts as their product and month', () => {
    expect(productName({ name: 'E-mini Nasdaq-100 Dec 2026' })).toBe('E-mini Nasdaq-100');
    expect(productName({ name: 'Gold' })).toBe('Gold');
    expect(contractMonth({ symbol: 'NQZ6', root: 'NQ', expiry: '2026-12-18' })).toBe('Dec 2026');
    expect(contractMonth({ symbol: 'CLF7', root: 'CL', expiry: '2026-12-17' })).toBe('Jan 2027');
    expect(contractMonth({ symbol: 'NQ-DEC', root: 'NQ', expiry: '2026-12-18' })).toBe('Dec 2026');
    expect(contractMonth({ symbol: 'QQQ', root: null, expiry: null })).toBeNull();
  });

  it('keeps each row’s connection, the desk’s data connection first, and an id once per connection', () => {
    const rows = rowsOf([apex, real, { ...real }]);
    expect(rows[0]).toMatchObject({ id: 'NQZ6.CME', connection: { id: 'rithmic', name: 'Rithmic' } });
    expect(rows.filter((r) => r.id === 'NQZ6.CME').map((r) => r.connection?.id)).toEqual(['rithmic', 'rithmic-apex']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('puts the contracts by exchange and root, each root’s months by expiry, a root of one contract untitled', () => {
    const sections = sectionsOf(rowsOf([apex]));
    expect(sections.map((s) => s.rows.map((r) => r.id))).toEqual([
      ['ESZ6.CME'],
      ['MNQZ6.CME'],
      ['NQZ6.CME', 'NQH7.CME'],
      ['GCZ6.COMEX'],
      ['CLX6.NYMEX'],
    ]);
    expect(sections.map((s) => s.title)).toEqual(['', '', 'NQ', '', '']);
    const nq = sections.find((s) => s.title === 'NQ')!;
    expect(nq.meta).toBe('E-mini Nasdaq-100 · CME');
    expect(nq.rows[0]!.instrument!.isFront).toBe(true);
  });

  it('counts what is listed, and nothing made up for a connection that lists nothing', () => {
    expect(listedCount(rowsOf([apex]))).toBe(6);
    expect(listedCount(rowsOf([{ ...real, instruments: [], error: 'not connected' }]))).toBe(0);
    expect(listedCount(symbolRows(['NQ'], [], 'w'))).toBe(0);
    expect(sectionsOf(rowsOf([{ ...real, instruments: [] }]))).toEqual([]);
  });
});

describe('the Markets area: search, filters and sorts', () => {
  const rows = rowsOf([apex, real]);

  it('searches symbols as listed and as traders write them, roots, names and exchanges', () => {
    const row = rows.find((r) => r.id === 'NQZ6.CME')!;
    for (const q of ['nq', 'NQ Z6', 'nqz6', 'nasdaq', 'cme', '']) expect(matchesQuery(row, q)).toBe(true);
    expect(matchesQuery(row, 'gold')).toBe(false);
    expect(filterRows(rows, { connection: null, query: 'gold' }).map((r) => r.id)).toEqual(['GCZ6.COMEX']);
  });

  it('filters by connection', () => {
    expect(filterRows(rows, { connection: null, query: '' })).toHaveLength(7);
    const fromRithmic = filterRows(rows, { connection: 'rithmic', query: '' });
    expect(fromRithmic.map((r) => r.connection?.id)).toEqual(['rithmic']);
  });

  it('sorts within each section, rows without a quote last, and keeps the sections in their order', () => {
    const q: Record<string, Quote> = {
      'NQZ6.CME': quote('NQZ6.CME', 25010, 24800, 300_000),
      'NQH7.CME': quote('NQH7.CME', 25200, 25190, 1_000),
      'ESZ6.CME': quote('ESZ6.CME', 6000, 5900),
    };
    const sections = sectionsOf(filterRows(rows, { connection: 'rithmic-apex', query: '' }));
    const of = (r: MarketRow) => q[r.id];
    const byPct = sortSections(sections, { key: 'pct', dir: 'desc' }, of);
    expect(byPct.map((s) => s.title)).toEqual(sections.map((s) => s.title));
    expect(byPct.find((s) => s.title === 'NQ')!.rows.map((r) => r.id)).toEqual(['NQZ6.CME', 'NQH7.CME']);
    const bySymbol = sortSections(sections, { key: 'symbol', dir: 'desc' }, of);
    expect(bySymbol.find((s) => s.title === 'NQ')!.rows.map((r) => r.id)).toEqual(['NQZ6.CME', 'NQH7.CME']);
    expect(sortSections(sections, null, of)).toEqual(sections);
  });

  it('what is moving: the largest move first either way, nothing that has not moved or not quoted', () => {
    const q: Record<string, Quote> = {
      'ESZ6.CME': quote('ESZ6.CME', 6000, 5900),
      'MNQZ6.CME': quote('MNQZ6.CME', 22500, 25000),
      'GCZ6.COMEX': quote('GCZ6.COMEX', 2650, 2650),
    };
    const moving = movingSection(rows, (r) => q[r.id]);
    expect(moving.rows.map((r) => r.id)).toEqual(['MNQZ6.CME', 'ESZ6.CME']);
  });

  it('lists a watchlist’s symbols in the user’s order, with the listing’s entry where one matches', () => {
    const wl = symbolRows(['NQ', 'ESZ6.CME', 'NQZ6.CME'], rows, 'w');
    expect(wl.map((r) => r.id)).toEqual(['NQ', 'ESZ6.CME', 'NQZ6.CME']);
    expect(wl[0]!.instrument).toBeNull();
    expect(wl[1]!.instrument?.name).toBe('E-mini S&P 500 Dec 2026');
    expect(new Set(wl.map((r) => r.key)).size).toBe(3);
    expect(flatRows([{ key: 'w', title: '', meta: '', rows: wl }])).toEqual(wl);
  });

  it('selects by click, ⌘-click and ⇧-click ranges', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const none = new Set<string>();
    expect([...clickSelection(order, none, null, 'b', { toggle: false, range: false })]).toEqual(['b']);
    expect([...clickSelection(order, new Set(['b']), 'b', 'd', { toggle: true, range: false })]).toEqual(['b', 'd']);
    expect([...clickSelection(order, new Set(['b', 'd']), 'd', 'd', { toggle: true, range: false })]).toEqual(['b']);
    expect([...clickSelection(order, new Set(['b']), 'b', 'e', { toggle: false, range: true })]).toEqual([
      'b',
      'c',
      'd',
      'e',
    ]);
    expect([...clickSelection(order, new Set(['a']), 'd', 'b', { toggle: true, range: true })].sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('where the Markets area is (ui.view.markets)', () => {
  it('reads what it can of a stored or asked-for place, an empty connection meaning every one', () => {
    expect(readPlace(null)).toEqual({});
    expect(
      readPlace({
        list: 'watchlist',
        watchlist: 'majors',
        connection: '',
        query: 'nq',
        moving: true,
        instrument: 'NQZ6.CME',
        sort: { key: 'pct', dir: 'desc' },
      }),
    ).toEqual({
      list: 'watchlist',
      watchlist: 'majors',
      connection: null,
      query: 'nq',
      moving: true,
      instrument: 'NQZ6.CME',
      sort: { key: 'pct', dir: 'desc' },
    });
    expect(readPlace({ moving: 'yes', sort: { key: 'beta', dir: 'up' } })).toEqual({});
    expect(readPlace({ sort: null, instrument: null })).toEqual({ sort: null, instrument: null });
    expect(readPlace(placeView(DEFAULT_PLACE))).toEqual(DEFAULT_PLACE);
  });

  it('reads a list this build does not have as All markets', () => {
    expect(readPlace({ list: 'futures' })).toEqual({ list: 'all' });
    expect(readPlace({ list: 'crypto', query: 'nq' })).toEqual({ list: 'all', query: 'nq' });
    expect(readPlace({ list: 'mars' })).toEqual({ list: 'all' });
  });
});

describe('the quotes a sort by a quote column reads', () => {
  it('asks the rows without a quote for one, six at a time, and takes no answer once the list is gone', async () => {
    const rt = fakeRuntime();
    const ids = Array.from({ length: 8 }, (_, i) => `SORT${String(i)}.TEST`);
    const { result, unmount } = renderHook(() => useSortQuotes(ids, true));
    const asks = () => rt.toolCalls('market.get_quote');
    await vi.waitFor(() => expect(asks()).toHaveLength(6));
    expect(asks().map((c) => c.input)).toEqual(ids.slice(0, 6).map((instrument) => ({ instrument })));
    await pause();
    expect(asks()).toHaveLength(6);
    quoteStore.apply(quote(ids[1]!, 101, 100));
    asks().forEach((c, i) => {
      if (i === 2) c.fail('not_found', 'no such instrument');
      else c.ok(quote(ids[i]!, 50 + i, 40));
    });
    await vi.waitFor(() => expect(asks()).toHaveLength(8));
    expect(result.current(ids[0]!)?.last).toBe(50);
    expect(result.current(ids[1]!)?.last).toBe(101);
    expect(result.current(ids[2]!)).toBeUndefined();
    expect(asks()[6]!.settled).toBe(false);
    unmount();
    asks()[6]!.ok(quote(ids[6]!, 56, 40));
    await pause();
    expect(quoteStore.get(ids[6]!)).toBeUndefined();
  });
});
