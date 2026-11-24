import { patch, read, makeStore, useStore } from '../app/store.ts';
import { DEFAULT_WATCHLIST } from '../market/defaults.ts';

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface Watchlists {
  lists: Watchlist[];
}

export const MAX_LISTS = 50;
export const MAX_SYMBOLS = 500;
export const MAX_NAME = 40;

const DEFAULT_WATCHLISTS: Watchlists = {
  lists: [{ id: 'main', name: 'Watchlist', symbols: [...DEFAULT_WATCHLIST] }],
};

export function readWatchlists(v: unknown): Watchlists | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const raw = (v as { lists?: unknown }).lists;
  if (!Array.isArray(raw)) return null;
  const lists: Watchlist[] = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const { id, name, symbols } = l as Record<string, unknown>;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || lists.some((x) => x.id === id)) continue;
    const syms = Array.isArray(symbols) ? symbols.filter((s): s is string => typeof s === 'string' && s !== '') : [];
    lists.push({ id, name, symbols: [...new Set(syms)] });
  }
  return { lists };
}

function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'list';
}

export function freeId(w: Watchlists, name: string): string {
  const base = slugOf(name);
  const taken = new Set(w.lists.map((l) => l.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${String(i)}`)) return `${base}-${String(i)}`;
}

export function freeName(w: Watchlists, base = 'Watchlist'): string {
  const taken = new Set(w.lists.map((l) => l.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${String(i)}`.toLowerCase())) return `${base} ${String(i)}`;
}

export function nameProblem(w: Watchlists, name: string, except: string | null = null): string | null {
  const n = name.trim();
  if (!n) return 'A watchlist needs a name';
  if (n.length > MAX_NAME) return `At most ${String(MAX_NAME)} characters`;
  if (w.lists.some((l) => l.id !== except && l.name.toLowerCase() === n.toLowerCase()))
    return `A watchlist is already called ${n}`;
  return null;
}

const clean = (symbols: readonly string[]): string[] => [
  ...new Set(symbols.map((s) => s.trim()).filter((s) => s !== '')),
];

const mapList = (w: Watchlists, id: string, fn: (l: Watchlist) => Watchlist): Watchlists => ({
  lists: w.lists.map((l) => (l.id === id ? fn(l) : l)),
});

export function createList(
  w: Watchlists,
  name: string,
  symbols: readonly string[] = [],
): { next: Watchlists; id: string | null } {
  if (w.lists.length >= MAX_LISTS) return { next: w, id: null };
  const n = name.trim().slice(0, MAX_NAME) || 'Watchlist';
  const free = nameProblem(w, n) ? freeName(w, n) : n;
  const id = freeId(w, free);
  return { next: { lists: [...w.lists, { id, name: free, symbols: clean(symbols).slice(0, MAX_SYMBOLS) }] }, id };
}

export function renameList(w: Watchlists, id: string, name: string): Watchlists {
  if (nameProblem(w, name, id)) return w;
  return mapList(w, id, (l) => ({ ...l, name: name.trim() }));
}

export function deleteList(w: Watchlists, id: string): Watchlists {
  return { lists: w.lists.filter((l) => l.id !== id) };
}

export function moveList(w: Watchlists, id: string, to: number): Watchlists {
  const list = w.lists.find((l) => l.id === id);
  if (!list) return w;
  const rest = w.lists.filter((l) => l.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return { lists: [...rest.slice(0, at), list, ...rest.slice(at)] };
}

export function addSymbols(w: Watchlists, id: string, symbols: readonly string[], at?: number): Watchlists {
  return mapList(w, id, (l) => {
    const fresh = clean(symbols).filter((s) => !l.symbols.includes(s));
    if (fresh.length === 0) return l;
    const i = at === undefined ? l.symbols.length : Math.max(0, Math.min(l.symbols.length, at));
    const next = [...l.symbols.slice(0, i), ...fresh, ...l.symbols.slice(i)];
    return { ...l, symbols: next.slice(0, MAX_SYMBOLS) };
  });
}

export function removeSymbols(w: Watchlists, id: string, symbols: readonly string[]): Watchlists {
  const drop = new Set(symbols);
  return mapList(w, id, (l) => ({ ...l, symbols: l.symbols.filter((s) => !drop.has(s)) }));
}

export function moveSymbol(w: Watchlists, id: string, symbol: string, to: number): Watchlists {
  return mapList(w, id, (l) => {
    if (!l.symbols.includes(symbol)) return l;
    const rest = l.symbols.filter((s) => s !== symbol);
    const at = Math.max(0, Math.min(rest.length, to));
    return { ...l, symbols: [...rest.slice(0, at), symbol, ...rest.slice(at)] };
  });
}

export function entryFor(l: Watchlist | undefined, id: string, resolved: string | null = null): string | null {
  if (!l) return null;
  return l.symbols.find((s) => s === id || (resolved !== null && s === resolved)) ?? null;
}

interface WatchlistsState {
  value: Watchlists;
  loaded: boolean;
}

export const watchlistsStore = makeStore<WatchlistsState>({ value: DEFAULT_WATCHLISTS, loaded: false });

export const useWatchlists = <T>(pick: (s: WatchlistsState) => T): T => useStore(watchlistsStore, pick);

export function putWatchlists(v: unknown): void {
  const w = readWatchlists(v);
  if (w) patch(watchlistsStore, { value: w, loaded: true });
}

export function editWatchlists(fn: (w: Watchlists) => Watchlists): void {
  const now = read(watchlistsStore).value;
  const next = fn(now);
  if (next !== now) patch(watchlistsStore, { value: next });
}
