import type { Instrument, Quote } from '@tessera/protocol';
import { displaySymbol } from '../../market/instruments.ts';
import { quoteChange } from '../../market/quotes.ts';
import { sortRows, sortValue, type MarketSort } from '../../markets/lists.ts';

export type MarketsList = 'all' | 'watchlist' | 'recent' | 'positions';
export const MARKETS_LISTS: readonly MarketsList[] = ['all', 'watchlist', 'recent', 'positions'];

export const LIST_WORD: Record<Exclude<MarketsList, 'watchlist'>, string> = {
  all: 'All markets',
  recent: 'Recent',
  positions: 'Positions',
};

export interface ConnectionTag {
  id: string;
  name: string;
  feedsDesk: boolean;
}

export interface ConnectionListing extends ConnectionTag {
  instruments: Instrument[];
  error: string | null;
}

export interface MarketRow {
  key: string;
  id: string;
  instrument: Instrument | null;
  connection: ConnectionTag | null;
}

export interface Section {
  key: string;
  title: string;
  meta: string;
  rows: MarketRow[];
}

const MONTH_YEAR = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/;

export function productName(i: Pick<Instrument, 'name'>): string {
  return i.name.replace(MONTH_YEAR, '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_CODES = 'FGHJKMNQUVXZ';
const MONTH_CODE = /^[A-Z]*([FGHJKMNQUVXZ])(\d{1,2})$/;

export function contractMonth(i: Pick<Instrument, 'symbol' | 'root' | 'expiry'>): string | null {
  const [y, m] = (i.expiry ?? '').split('-');
  const root = i.root?.trim().toUpperCase();
  const symbol = i.symbol.trim().toUpperCase();
  const code = root && symbol.startsWith(root) ? MONTH_CODE.exec(symbol.slice(root.length)) : null;
  if (code) {
    const year = contractYear(code[2]!, Number(y) || new Date().getUTCFullYear());
    return `${MONTHS[MONTH_CODES.indexOf(code[1]!)]!} ${String(year)}`;
  }
  const month = MONTHS[Number(m) - 1];
  return y && month ? `${month} ${y}` : null;
}

function contractYear(digits: string, reference: number): number {
  if (digits.length === 2) return 2000 + Number(digits);
  const year = reference - (reference % 10) + Number(digits);
  if (year < reference - 2) return year + 10;
  if (year > reference + 7) return year - 10;
  return year;
}

export function rowsOf(listings: readonly ConnectionListing[]): MarketRow[] {
  const out: MarketRow[] = [];
  const seen = new Set<string>();
  const ordered = [...listings].sort((a, b) => Number(b.feedsDesk) - Number(a.feedsDesk));
  for (const l of ordered) {
    const tag: ConnectionTag = { id: l.id, name: l.name, feedsDesk: l.feedsDesk };
    for (const i of l.instruments) {
      const key = `${l.id}\u0000${i.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, id: i.id, instrument: i, connection: tag });
    }
  }
  return out;
}

export function matchesQuery(row: MarketRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const i = row.instrument;
  const words = [row.id, displaySymbol(row.id), i?.symbol, i?.root, i?.name, i?.exchange];
  const compact = q.replace(/\s+/g, '');
  return words.some((w) => {
    if (!w) return false;
    const l = w.toLowerCase();
    return l.includes(q) || l.replace(/\s+/g, '').includes(compact);
  });
}

export interface ListingFilter {
  connection: string | null;
  query: string;
}

export function filterRows(rows: readonly MarketRow[], f: ListingFilter): MarketRow[] {
  return rows.filter((r) => (f.connection === null || r.connection?.id === f.connection) && matchesQuery(r, f.query));
}

export function sectionsOf(rows: readonly MarketRow[]): Section[] {
  const roots = new Map<string, MarketRow[]>();
  for (const r of rows) {
    const i = r.instrument;
    if (!i) continue;
    const k = `${i.exchange}\u0000${i.root ?? i.symbol}`;
    roots.set(k, [...(roots.get(k) ?? []), r]);
  }
  return [...roots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rs]) => {
      if (rs.length === 1) return { key: `market:${k}`, title: '', meta: '', rows: rs };
      const first = rs[0]!.instrument!;
      const sorted = [...rs].sort(
        (a, b) =>
          (a.instrument!.expiry ?? '').localeCompare(b.instrument!.expiry ?? '') ||
          Number(b.instrument!.isFront) - Number(a.instrument!.isFront),
      );
      return {
        key: `futures:${k}`,
        title: first.root ?? displaySymbol(first.id),
        meta: [productName(first), first.exchange].filter(Boolean).join(' · '),
        rows: sorted,
      };
    });
}

export function rowName(sectionKey: string, i: Instrument): string {
  if (sectionKey.startsWith('futures:')) return contractMonth(i) ?? i.name;
  if (!sectionKey.startsWith('market:')) return i.name;
  const product = [productName(i), contractMonth(i)].filter(Boolean).join(' ');
  return [product, i.exchange].filter(Boolean).join(' · ');
}

export function sortSections(
  sections: readonly Section[],
  sort: MarketSort | null,
  quoteOf: (row: MarketRow) => Quote | undefined,
): Section[] {
  if (!sort) return [...sections];
  return sections.map((s) => ({
    ...s,
    rows: sortRows(s.rows, sort, (r, k) => sortValue(k, displaySymbol(r.id), quoteOf(r))),
  }));
}

export function movingSection(rows: readonly MarketRow[], quoteOf: (row: MarketRow) => Quote | undefined): Section {
  const moved = rows
    .map((r) => ({ r, pct: quoteChange(quoteOf(r)).pct }))
    .filter((x): x is { r: MarketRow; pct: number } => x.pct !== null && x.pct !== 0)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .map((x) => x.r);
  return { key: 'moving', title: 'Top movers', meta: '', rows: moved };
}

export function symbolRows(symbols: readonly string[], listed: readonly MarketRow[], prefix: string): MarketRow[] {
  return symbols.map((s) => {
    const hit = listed.find((r) => r.id === s);
    return {
      key: `${prefix}\u0000${s}`,
      id: s,
      instrument: hit?.instrument ?? null,
      connection: hit?.connection ?? null,
    };
  });
}

export function listedCount(rows: readonly MarketRow[]): number {
  return rows.filter((r) => r.instrument !== null).length;
}

export function flatRows(sections: readonly Section[]): MarketRow[] {
  return sections.flatMap((s) => s.rows);
}

export function clickSelection(
  order: readonly string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  key: string,
  mods: { toggle: boolean; range: boolean },
): Set<string> {
  if (mods.range && anchor !== null && order.includes(anchor)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(key);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return new Set([...(mods.toggle ? selected : []), ...order.slice(lo, hi + 1)]);
  }
  if (mods.toggle) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }
  return new Set([key]);
}
