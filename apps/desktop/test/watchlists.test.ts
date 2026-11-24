import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rustNumber } from './support/rust.ts';
import { patch, read } from '../src/app/store.ts';
import type { Watchlists } from '../src/markets/watchlists.ts';
import { showArea, areaStore } from '../src/areas/store.ts';

const calls: string[] = [];
vi.mock('../src/workspace/controller.ts', () => ({
  setChartInstrument: (i: string) => (calls.push(`chart ${i}`), Promise.resolve(true)),
}));
vi.mock('../src/workspace/addChart.ts', () => ({
  showInstrument: (i: string) => (calls.push(`chart ${i}`), Promise.resolve(true)),
  openChartTab: (i: string) => (calls.push(`tab ${i}`), Promise.resolve(i === 'FULL' ? null : 'chart-9')),
  splitWithSymbol: (i: string) => (calls.push(`split ${i}`), Promise.resolve(true)),
}));
vi.mock('../src/workspace/dock/open.ts', () => ({
  openTile: (kind: string, o: { params: Record<string, unknown> }) => (
    calls.push(`${kind} ${JSON.stringify(o.params)}`),
    'dom-1'
  ),
}));

const w = await import('../src/markets/watchlists.ts');
const actions = await import('../src/markets/actions.ts');

const lists = (...l: [string, string, string[]][]): Watchlists => ({
  lists: l.map(([id, name, symbols]) => ({ id, name, symbols })),
});

describe('watchlists, pure', () => {
  const base = lists(['main', 'Watchlist', ['NQ', 'ES', 'QQQ']], ['crypto', 'Crypto', ['BTCUSD']]);

  it('creates a list with a free id and name, its symbols cleaned, up to the most lists', () => {
    const a = w.createList(base, 'Futures majors', [' NQ ', 'ES', 'NQ', '']);
    expect(a.id).toBe('futures-majors');
    expect(a.next.lists.at(-1)).toEqual({ id: 'futures-majors', name: 'Futures majors', symbols: ['NQ', 'ES'] });
    const b = w.createList(base, 'watchlist');
    expect(b.next.lists.at(-1)).toMatchObject({ id: 'watchlist-2', name: 'watchlist 2' });
    expect(w.freeId(lists(['list', 'x', []]), '!!!')).toBe('list-2');
    expect(w.freeName(base)).toBe('Watchlist 2');
    const full = {
      lists: Array.from({ length: w.MAX_LISTS }, (_, i) => ({
        id: `l${String(i)}`,
        name: `L${String(i)}`,
        symbols: [],
      })),
    };
    expect(w.createList(full, 'One more')).toEqual({ next: full, id: null });
  });

  it('renames only to a name no other list has, and never to nothing', () => {
    expect(w.renameList(base, 'main', '  Core ').lists[0]!.name).toBe('Core');
    expect(w.renameList(base, 'main', 'crypto')).toBe(base);
    expect(w.renameList(base, 'main', '   ')).toBe(base);
    expect(w.nameProblem(base, 'CRYPTO')).toBe('A watchlist is already called CRYPTO');
    expect(w.nameProblem(base, 'Crypto', 'crypto')).toBeNull();
    expect(w.nameProblem(base, 'x'.repeat(41))).toBe('At most 40 characters');
  });

  it('adds what a list lacks in order, where asked; removes; moves a symbol and a list', () => {
    expect(w.addSymbols(base, 'main', ['SPY', 'NQ', 'TSLA']).lists[0]!.symbols).toEqual([
      'NQ',
      'ES',
      'QQQ',
      'SPY',
      'TSLA',
    ]);
    expect(w.addSymbols(base, 'main', ['SPY'], 1).lists[0]!.symbols).toEqual(['NQ', 'SPY', 'ES', 'QQQ']);
    expect(w.addSymbols(base, 'main', ['NQ']).lists[0]).toBe(base.lists[0]);
    expect(w.removeSymbols(base, 'main', ['ES', 'AAPL']).lists[0]!.symbols).toEqual(['NQ', 'QQQ']);
    expect(w.moveSymbol(base, 'main', 'QQQ', 0).lists[0]!.symbols).toEqual(['QQQ', 'NQ', 'ES']);
    expect(w.moveSymbol(base, 'main', 'NQ', 99).lists[0]!.symbols).toEqual(['ES', 'QQQ', 'NQ']);
    expect(w.moveList(base, 'crypto', 0).lists.map((l) => l.id)).toEqual(['crypto', 'main']);
    expect(w.deleteList(base, 'main').lists.map((l) => l.id)).toEqual(['crypto']);
    expect(w.entryFor(base.lists[0], 'NQZ6.CME', 'NQ')).toBe('NQ');
    expect(w.entryFor(base.lists[0], 'NVDA')).toBeNull();
  });

  it('reads a stored value as it can, each list once and each symbol once', () => {
    expect(w.readWatchlists(null)).toBeNull();
    expect(w.readWatchlists({ lists: 3 })).toBeNull();
    expect(
      w.readWatchlists({
        lists: [
          { id: 'a', name: 'A', symbols: ['NQ', 'NQ', 7, 'ES'] },
          { id: 'a', name: 'Again', symbols: [] },
          { id: '', name: 'No id' },
          { id: 'b', name: 'B' },
        ],
      }),
    ).toEqual({
      lists: [
        { id: 'a', name: 'A', symbols: ['NQ', 'ES'] },
        { id: 'b', name: 'B', symbols: [] },
      ],
    });
  });
});

describe('watchlist and open actions', () => {
  beforeEach(() => {
    calls.length = 0;
    patch(w.watchlistsStore, { value: lists(['main', 'Watchlist', ['NQ']]), loaded: true });
    showArea('markets');
  });

  it('edits the window’s lists, which the settings sync writes to the runtime', () => {
    actions.addToWatchlist('main', ['ES', 'NQ']);
    expect(read(w.watchlistsStore).value.lists[0]!.symbols).toEqual(['NQ', 'ES']);
    const id = actions.newWatchlist(['BTCUSD']);
    expect(id).toBe('watchlist-2');
    expect(read(w.watchlistsStore).value.lists.map((l) => [l.name, l.symbols])).toEqual([
      ['Watchlist', ['NQ', 'ES']],
      ['Watchlist 2', ['BTCUSD']],
    ]);
    expect(actions.listsHolding('NQZ6.CME', 'NQ')).toEqual(['main']);
    actions.removeFromWatchlist('main', ['NQ']);
    expect(read(w.watchlistsStore).value.lists[0]!.symbols).toEqual(['ES']);
    const before = read(w.watchlistsStore).value;
    actions.removeFromWatchlist('main', ['NQ']);
    expect(read(w.watchlistsStore).value).toEqual(before);
  });

  it('opens a market on the desk: the active chart, a new tab, a split or a pinned DOM', async () => {
    await actions.openMarket('NQ', 'chart');
    expect(read(areaStore).area).toBe('desk');
    await actions.openMarket('ES', 'tab');
    await actions.openMarket('QQQ', 'split');
    expect(await actions.openMarket('NQZ6.CME', 'dom')).toBe(true);
    expect(calls).toEqual(['chart NQ', 'tab ES', 'split QQQ', 'dom {"instrument":"NQZ6.CME","link":null}']);
  });

  it('opens a selection: each in its own tab until the workspace is full; on the chart only the first', async () => {
    await actions.openMarkets(['NQ', 'FULL', 'ES'], 'tab');
    expect(calls).toEqual(['tab NQ', 'tab FULL']);
    calls.length = 0;
    await actions.openMarkets(['NQ', 'ES'], 'chart');
    expect(calls).toEqual(['chart NQ']);
  });
});

describe('the watchlist limits', () => {
  it('are the runtime schema’s', () => {
    const limit = (name: string) => rustNumber('tessera-protocol/src/watchlists.rs', name);
    expect({ lists: w.MAX_LISTS, symbols: w.MAX_SYMBOLS, name: w.MAX_NAME }).toEqual({
      lists: limit('LISTS_MAX'),
      symbols: limit('SYMBOLS_MAX'),
      name: limit('NAME_MAX'),
    });
  });
});
