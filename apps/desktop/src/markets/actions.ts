import { showArea } from '../areas/store.ts';
import { openChartTab, showInstrument, splitWithSymbol } from '../workspace/addChart.ts';
import { openTile } from '../workspace/dock/open.ts';
import {
  addSymbols,
  createList,
  editWatchlists,
  removeSymbols,
  type Watchlists,
  watchlistsStore,
} from './watchlists.ts';
import { read } from '../app/store.ts';

export type OpenHow = 'chart' | 'tab' | 'split' | 'dom';

export const OPEN_WORDS: Record<OpenHow, string> = {
  chart: 'Open in chart',
  tab: 'Open in new tab',
  split: 'Open as split',
  dom: 'Open DOM',
};

export const OPEN_KEYS: Record<OpenHow, string> = {
  chart: 'enter',
  tab: 'mod+enter',
  split: 'shift+enter',
  dom: 'alt+enter',
};

export async function openMarket(instrument: string, how: OpenHow): Promise<boolean> {
  showArea('desk');
  if (how === 'chart') return showInstrument(instrument);
  if (how === 'tab') return (await openChartTab(instrument)) !== null;
  if (how === 'split') return splitWithSymbol(instrument);
  return openTile('dom', { params: { instrument, link: null }, via: 'pointer' }) !== null;
}

export async function openMarkets(instruments: readonly string[], how: OpenHow): Promise<void> {
  if (how === 'chart') {
    if (instruments[0]) await openMarket(instruments[0], 'chart');
    return;
  }
  for (const i of instruments) if (!(await openMarket(i, how))) break;
}

export function addToWatchlist(id: string, symbols: readonly string[]): void {
  editWatchlists((w) => addSymbols(w, id, symbols));
}

export function removeFromWatchlist(id: string, symbols: readonly string[]): void {
  editWatchlists((w) => removeSymbols(w, id, symbols));
}

export function newWatchlist(symbols: readonly string[] = [], name = 'Watchlist'): string | null {
  let made: string | null = null;
  editWatchlists((w: Watchlists) => {
    const { next, id } = createList(w, name, symbols);
    made = id;
    return next;
  });
  return made;
}

export function listsHolding(id: string, resolved: string | null = null): string[] {
  return read(watchlistsStore)
    .value.lists.filter((l) => l.symbols.includes(id) || (resolved !== null && l.symbols.includes(resolved)))
    .map((l) => l.id);
}
