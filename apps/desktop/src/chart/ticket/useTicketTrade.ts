import type { AccountUpdate, Environment, Order, Position } from '@tessera/protocol';
import { useMemo } from 'react';
import { useAccountUpdates, usePositions } from '../../app/portfolio.ts';
import { chartInstrumentNow, routedAccountNow, useRoutedAccount } from '../../markets/useRoutes.ts';
import { useOrderEntry, type OrderEntry } from '../../shell/orderEntry.ts';
import { useShellData } from '../../shell/shellData.ts';
import { useLayouts, layoutsStore } from '../../state/layouts.ts';
import {
  patchTicket,
  pinTickets,
  resolveTicketAccount,
  ticketAccountId,
  useTicketSetup,
  type TicketSetup,
  ticketsStore,
} from '../../state/tickets.ts';
import { useUi, uiStore, setTradeAccount } from '../../state/ui.ts';
import { workspaceContext } from '../../workspace/controller.ts';
import { read } from '../../app/store.ts';

export interface TicketTrade {
  setup: TicketSetup;
  update: AccountUpdate | null;
  positions: Position[];
  orders: Order[];
  env: Environment | null;
  entry: OrderEntry;
}

const NONE: never[] = [];

export function useTicketTrade(tileId: string): TicketTrade {
  const { allOrders, env: windowEnv } = useShellData();
  const accountUpdates = useAccountUpdates() ?? NONE;
  const allPositions = usePositions() ?? NONE;
  const setup = useTicketSetup(tileId);
  const startWith = useUi((s) => s.tradeAccount);
  const instrument = useLayouts(() => chartInstrumentNow(tileId));
  const routed = useRoutedAccount(instrument);
  const update = resolveTicketAccount(accountUpdates, setup.accountId, routed, startWith);
  const id = update?.account.id ?? null;
  const positions = useMemo(() => allPositions.filter((p) => p.accountId === id), [allPositions, id]);
  const orders = useMemo(() => allOrders.filter((o) => o.request.accountId === id), [allOrders, id]);
  const entry = useOrderEntry(update?.account ?? null);
  return { setup, update, positions, orders, env: update?.account.environment ?? windowEnv, entry };
}

export function pickTicketAccount(tileId: string, accountId: string, accounts: readonly { id: string }[]): void {
  const { tickets } = read(ticketsStore);
  const ctx = workspaceContext();
  const charts = ctx ? Object.keys(read(layoutsStore).layouts[ctx.layoutId]?.charts ?? {}) : [];
  const tiles = [...new Set([...charts, ...Object.keys(tickets)])].filter((id) => id !== tileId);
  const startWith = read(uiStore).tradeAccount;
  pinTickets(tiles, (tile) =>
    routedAccountNow(chartInstrumentNow(tile)) !== null ? null : ticketAccountId(accounts, null, null, startWith),
  );
  patchTicket(tileId, { accountId });
  setTradeAccount(accountId);
}
