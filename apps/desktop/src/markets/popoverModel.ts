import type { Instrument } from '@tessera/protocol';
import { z } from 'zod';
import { patch, makeStore, useStore } from '../app/store.ts';
import { contractMonth, productName } from '../areas/markets/model.ts';

export type Tab = 'watchlist' | 'futures' | 'recent';
export const TABS: readonly Tab[] = ['watchlist', 'futures', 'recent'];
export const TAB_WORD: Record<Tab, string> = { watchlist: 'Watchlist', futures: 'Futures', recent: 'Recent' };

interface PopoverPlace {
  tab: Tab;
  watchlist: string | null;
}

export const popoverPlaceStore = makeStore<PopoverPlace>(
  { tab: 'watchlist', watchlist: null },
  {
    persist: {
      key: 'tessera.symbolPopover',
      version: 1,
      fields: { tab: z.enum(TABS), watchlist: z.string().nullable() },
    },
  },
);

export function usePopoverPlace(): PopoverPlace {
  return useStore(popoverPlaceStore);
}

export function setPopoverPlace(change: Partial<PopoverPlace>): void {
  patch(popoverPlaceStore, change);
}

export interface PopoverRow {
  id: string;
  name: string | null;
  heading: string | null;
  front: boolean;
}

export function futuresRows(instruments: readonly Instrument[]): PopoverRow[] {
  const sorted = [...instruments].sort(
    (a, b) =>
      a.exchange.localeCompare(b.exchange) ||
      (a.root ?? a.symbol).localeCompare(b.root ?? b.symbol) ||
      (a.expiry ?? '').localeCompare(b.expiry ?? ''),
  );
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: PopoverRow[] = [];
  for (const i of sorted) {
    if (ids.has(i.id)) continue;
    ids.add(i.id);
    const root = `${i.exchange}:${i.root ?? i.symbol}`;
    const heading = seen.has(root) ? null : `${i.root ?? i.symbol} · ${productName(i)}`;
    seen.add(root);
    out.push({ id: i.id, name: contractMonth(i) ?? i.name, heading, front: i.isFront });
  }
  return out;
}

export function symbolRows(symbols: readonly string[]): PopoverRow[] {
  return symbols.map((id) => ({ id, name: null, heading: null, front: false }));
}

export function nextTab(tab: Tab, d: 1 | -1): Tab {
  const i = TABS.indexOf(tab);
  return TABS[(i + d + TABS.length) % TABS.length]!;
}
