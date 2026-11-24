import type { Position, Quote } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { quoteChange } from '../market/quotes.ts';

export type MarketSortKey = 'symbol' | 'last' | 'chg' | 'pct' | 'vol';
export interface MarketSort {
  key: MarketSortKey;
  dir: 'asc' | 'desc';
}

export function nextSort(cur: MarketSort | null | undefined, key: MarketSortKey): MarketSort | null {
  const first: MarketSort['dir'] = key === 'symbol' ? 'asc' : 'desc';
  if (cur?.key !== key) return { key, dir: first };
  if (cur.dir === first) return { key, dir: first === 'asc' ? 'desc' : 'asc' };
  return null;
}

export function sortValue(key: MarketSortKey, label: string, q: Quote | undefined): string | number | null {
  if (key === 'symbol') return label;
  if (key === 'last') return q?.last ?? null;
  const { change, pct } = quoteChange(q);
  if (key === 'chg') return change;
  if (key === 'pct') return pct;
  const v = q?.session?.volume ?? null;
  return v && v > 0 ? v : null;
}

export function sortRows<T>(
  rows: readonly T[],
  sort: MarketSort | null | undefined,
  value: (row: T, key: MarketSortKey) => string | number | null,
): T[] {
  if (!sort) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row, sort.key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = typeof a.v === 'string' ? a.v.localeCompare(String(b.v)) : a.v - (b.v as number);
      return c === 0 ? a.i - b.i : sign * c;
    })
    .map((x) => x.row);
}

export function positionLine(p: Position): { text: string; tone: 'up' | 'down' | null } {
  const side = p.qty > 0 ? 'Long' : 'Short';
  const pnl = p.unrealizedPnl;
  const money = pnl ? ` · ${formatMoney(pnl, { signed: true })}` : '';
  return {
    text: `${side} ${String(Math.abs(p.qty))}${money}`,
    tone: !pnl || pnl.amount === 0 ? null : pnl.amount > 0 ? 'up' : 'down',
  };
}

export function rangeAt(q: Quote | undefined): number | null {
  const lo = q?.session?.low ?? null;
  const hi = q?.session?.high ?? null;
  const last = q?.last ?? null;
  if (lo === null || hi === null || last === null || hi <= lo) return null;
  return Math.min(1, Math.max(0, (last - lo) / (hi - lo)));
}
