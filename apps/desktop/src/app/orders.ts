import type { DraftInfo, Order, OrderPreview, OrderStatus, OrderUpdate, TradingAccount } from '@tessera/protocol';
import { derived, useStore, type Readable } from './store.ts';
import { topicFold } from './topics.ts';

const OPEN: ReadonlySet<OrderStatus> = new Set([
  'pending_submit',
  'held',
  'working',
  'partially_filled',
  'pending_cancel',
]);

export function isOpenOrder(o: Order): boolean {
  return OPEN.has(o.status);
}

export interface AccountRef {
  id: string;
  name: string;
}

export interface AccountOrders {
  account: AccountRef;
  orders: Order[];
}

export function ordersElsewhere(
  orders: readonly Order[],
  accountId: string | null,
  accounts: readonly TradingAccount[],
): AccountOrders[] {
  return accounts
    .filter((a) => a.id !== accountId)
    .map((a) => ({
      account: { id: a.id, name: a.displayName },
      orders: orders.filter((o) => o.request.accountId === a.id),
    }))
    .filter((g) => g.orders.length > 0);
}

export function reduceOrders(prev: ReadonlyMap<string, Order>, ev: OrderUpdate): Map<string, Order> {
  const next = new Map(prev);
  if (isOpenOrder(ev.order)) next.set(ev.order.id, ev.order);
  else next.delete(ev.order.id);
  return next;
}

export function reduceDrafts(prev: ReadonlyMap<string, DraftInfo>, ev: DraftInfo): Map<string, DraftInfo> {
  const next = new Map(prev);
  if (ev.status === 'live') next.set(ev.draftId, ev);
  else next.delete(ev.draftId);
  return next;
}

export function orderPreviewOf(d: DraftInfo): OrderPreview | null {
  const p = d.preview;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const req = (p as Record<string, unknown>).request;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null;
  const r = req as Record<string, unknown>;
  if ((r.side !== 'buy' && r.side !== 'sell') || typeof r.qty !== 'number' || typeof r.orderType !== 'string') {
    return null;
  }
  return p as unknown as OrderPreview;
}

const openOrdersStore: Readable<Order[] | null> = derived(
  topicFold('orders', {}, { empty: () => new Map<string, Order>(), reduce: reduceOrders }),
  (map) => (map ? [...map.values()].sort((a, b) => a.createdAt - b.createdAt) : null),
);

export function useOpenOrders(): Order[] | null {
  return useStore(openOrdersStore);
}

const liveDraftsStore: Readable<DraftInfo[] | null> = derived(
  topicFold('drafts', {}, { empty: () => new Map<string, DraftInfo>(), reduce: reduceDrafts }),
  (map) => (map ? [...map.values()] : null),
);

export function useLiveDrafts(): DraftInfo[] | null {
  return useStore(liveDraftsStore);
}
