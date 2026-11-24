import { useMemo } from 'react';
import { layoutsStore } from '../state/layouts.ts';
import { BASE_TICKET, patchTicket, ticketOf, ticketsStore } from '../state/tickets.ts';
import { useRuntimeSetting, runtimeSettingsStore } from '../state/runtimeSettings.ts';
import { workspaceContext } from '../workspace/controller.ts';
import { useListing } from './listing.ts';
import {
  ACCOUNT_BY_EXCHANGE,
  DATA_BY_EXCHANGE,
  exchangeOf,
  exchangeOfId,
  readRoutes,
  routedAccount,
  type ExchangeRoutes,
} from './routes.ts';
import { read } from '../app/store.ts';

export function useExchangeRoutes(): { data: ExchangeRoutes; accounts: ExchangeRoutes } {
  const data = useRuntimeSetting(DATA_BY_EXCHANGE);
  const accounts = useRuntimeSetting(ACCOUNT_BY_EXCHANGE);
  return useMemo(() => ({ data: readRoutes(data), accounts: readRoutes(accounts) }), [data, accounts]);
}

export function useRoutedAccount(instrument: string | null): string | null {
  const { accounts } = useExchangeRoutes();
  const named = instrument ? exchangeOfId(instrument) : null;
  const ask = instrument !== null && named === null && Object.keys(accounts).length > 0;
  const { listings } = useListing(ask);
  return routedAccount(accounts, instrument ? (named ?? exchangeOf(instrument, listings)) : null);
}

export function routedAccountNow(instrument: string | null): string | null {
  if (!instrument) return null;
  return routedAccount(readRoutes(read(runtimeSettingsStore).values[ACCOUNT_BY_EXCHANGE]), exchangeOfId(instrument));
}

export function chartInstrumentNow(tileId: string): string | null {
  const ctx = workspaceContext();
  return ctx ? (read(layoutsStore).layouts[ctx.layoutId]?.charts[tileId]?.instrument ?? null) : null;
}

export function followRoute(exchange: string | null, accounts: ExchangeRoutes): void {
  const ctx = workspaceContext();
  const charts = ctx ? (read(layoutsStore).layouts[ctx.layoutId]?.charts ?? {}) : {};
  const tickets = read(ticketsStore).tickets;
  for (const [tileId, chart] of Object.entries(charts)) {
    if (tileId === BASE_TICKET || ticketOf(tickets, tileId).accountId === null) continue;
    const ex = exchangeOfId(chart.instrument);
    const covered = exchange === null ? routedAccount(accounts, ex) === null : ex === exchange;
    if (covered) patchTicket(tileId, { accountId: null });
  }
}
