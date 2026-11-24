import { z } from 'zod';
import { patch, read, makeStore, type Persist, useStore } from '../../app/store.ts';
import type { MarketSort, MarketSortKey } from '../../markets/lists.ts';
import { MARKETS_LISTS, type MarketsList } from './model.ts';

export interface MarketsPlace {
  list: MarketsList;
  watchlist: string | null;
  connection: string | null;
  query: string;
  moving: boolean;
  instrument: string | null;
  sort: MarketSort | null;
}

export const DEFAULT_PLACE: MarketsPlace = {
  list: 'all',
  watchlist: null,
  connection: null,
  query: '',
  moving: false,
  instrument: null,
  sort: null,
};

const SORT_KEYS: readonly MarketSortKey[] = ['symbol', 'last', 'chg', 'pct', 'vol'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readSort(v: unknown): MarketSort | null | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  const { key, dir } = v;
  return SORT_KEYS.includes(key as MarketSortKey) && (dir === 'asc' || dir === 'desc')
    ? { key: key as MarketSortKey, dir }
    : undefined;
}

export function readPlace(v: unknown): Partial<MarketsPlace> {
  if (!isObject(v)) return {};
  const out: Partial<MarketsPlace> = {};
  if (typeof v.list === 'string' && v.list)
    out.list = MARKETS_LISTS.includes(v.list as MarketsList) ? (v.list as MarketsList) : 'all';
  const idOrNull = (x: unknown): string | null | undefined =>
    x === null || x === '' ? null : typeof x === 'string' ? x : undefined;
  const watchlist = idOrNull(v.watchlist);
  if (watchlist !== undefined) out.watchlist = watchlist;
  const connection = idOrNull(v.connection);
  if (connection !== undefined) out.connection = connection;
  if (typeof v.query === 'string') out.query = v.query;
  if (typeof v.moving === 'boolean') out.moving = v.moving;
  const instrument = idOrNull(v.instrument);
  if (instrument !== undefined) out.instrument = instrument;
  const sort = readSort(v.sort);
  if (sort !== undefined) out.sort = sort;
  return out;
}

export function placeView(p: MarketsPlace): Record<string, string | boolean | MarketSort | null> {
  return {
    list: p.list,
    watchlist: p.watchlist,
    connection: p.connection,
    query: p.query,
    moving: p.moving,
    instrument: p.instrument,
    sort: p.sort,
  };
}

const storedId = () =>
  z
    .string()
    .nullable()
    .transform((id) => (id === null || id === '' ? null : id));

const PERSISTED: Persist<MarketsPlace>['fields'] = {
  list: z.enum(MARKETS_LISTS),
  watchlist: storedId(),
  connection: storedId(),
  moving: z.boolean(),
  instrument: storedId(),
  sort: z.object({ key: z.enum(SORT_KEYS), dir: z.enum(['asc', 'desc']) }).nullable(),
};

export const marketsUiStore = makeStore<MarketsPlace>(DEFAULT_PLACE, {
  persist: { key: 'tessera.markets', version: 1, fields: PERSISTED },
});

export const useMarketsUi = <T>(pick: (s: MarketsPlace) => T): T => useStore(marketsUiStore, pick);

export function setMarketsPlace(change: Partial<MarketsPlace>): void {
  patch(marketsUiStore, change);
}

export function currentPlace(): MarketsPlace {
  return read(marketsUiStore);
}
