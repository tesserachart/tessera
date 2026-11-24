import type { AccountUpdate } from '@tessera/protocol';
import { patch, read, makeStore, useStore } from '../app/store.ts';
import { readExecuteAs, type ExecuteAs } from '../market/families.ts';
import { STOP_LIMIT_TICKS } from '../shell/ticket.ts';

type TicketEntry = 'market' | 'limit' | 'stop';

export type Sizing = 'qty' | 'risk';

type Fold = 'open' | 'closed';

export interface TicketSetup {
  accountId: string | null;
  qty: number;
  entry: TicketEntry;
  sizing: Sizing;
  risk: number;
  bracket: Fold;
  rules: Fold;
  stopLimitTicks: number;
  execute: ExecuteAs;
}

export const DEFAULT_TICKET: TicketSetup = {
  accountId: null,
  qty: 1,
  entry: 'market',
  sizing: 'qty',
  risk: 250,
  bracket: 'open',
  rules: 'closed',
  stopLimitTicks: STOP_LIMIT_TICKS,
  execute: 'chart',
};

export const BASE_TICKET = '*';

export function readTicketSetup(v: unknown): TicketSetup {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
  const ticks = o.stopLimitTicks;
  return {
    accountId: typeof o.accountId === 'string' && o.accountId !== '' ? o.accountId : null,
    qty: Math.floor(n(o.qty) ?? DEFAULT_TICKET.qty) || 1,
    entry: 'market',
    sizing: o.sizing === 'risk' ? 'risk' : 'qty',
    risk: n(o.risk) ?? DEFAULT_TICKET.risk,
    bracket: o.bracket === 'closed' ? 'closed' : 'open',
    rules: o.rules === 'open' ? 'open' : 'closed',
    stopLimitTicks:
      typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0
        ? Math.min(MAX_STOP_LIMIT_TICKS, Math.round(ticks))
        : DEFAULT_TICKET.stopLimitTicks,
    execute: readExecuteAs(o.execute),
  };
}

export const MAX_STOP_LIMIT_TICKS = 99;

export interface TicketsState {
  tickets: Record<string, TicketSetup>;
}

export function ticketOf(tickets: Readonly<Record<string, TicketSetup>>, tileId: string): TicketSetup {
  return tickets[tileId] ?? tickets[BASE_TICKET] ?? DEFAULT_TICKET;
}

export const ticketsStore = makeStore<TicketsState>({ tickets: {} });

export function useTicketSetup(tileId: string): TicketSetup {
  return useStore(ticketsStore, (s) => ticketOf(s.tickets, tileId));
}

export function patchTicket(tileId: string, change: Partial<TicketSetup>): void {
  const { tickets } = read(ticketsStore);
  const next = readTicketSetup({ ...ticketOf(tickets, tileId), ...change });
  patch(ticketsStore, { tickets: { ...tickets, [tileId]: next } });
}

export function replaceTickets(tickets: Record<string, TicketSetup>): void {
  patch(ticketsStore, { tickets });
}

export function pinTickets(tileIds: readonly string[], resolve: (tileId: string) => string | null): void {
  const { tickets } = read(ticketsStore);
  const next = { ...tickets };
  let pinned = false;
  for (const id of tileIds) {
    if (id === BASE_TICKET || ticketOf(tickets, id).accountId !== null) continue;
    const accountId = resolve(id);
    if (!accountId) continue;
    next[id] = { ...ticketOf(tickets, id), accountId };
    pinned = true;
  }
  if (pinned) patch(ticketsStore, { tickets: next });
}

export function ticketAccountId(
  accounts: readonly { id: string }[],
  own: string | null,
  routed: string | null,
  startWith: string | null,
): string | null {
  const listed = (id: string | null) => id !== null && accounts.some((a) => a.id === id);
  return [own, routed, startWith].find(listed) ?? accounts[0]?.id ?? null;
}

export function resolveTicketAccount(
  updates: readonly AccountUpdate[],
  own: string | null,
  routed: string | null,
  startWith: string | null,
): AccountUpdate | null {
  const id = ticketAccountId(
    updates.map((u) => u.account),
    own,
    routed,
    startWith,
  );
  return updates.find((u) => u.account.id === id) ?? null;
}
