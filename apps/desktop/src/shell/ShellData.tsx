import type { TradingAccount } from '@tessera/protocol';
import { useMemo, type ReactNode } from 'react';
import { useAnalyst } from '../analyst/analystStore.ts';
import { healthStore } from '../app/health.ts';
import { useOpenOrders } from '../app/orders.ts';
import { positionsStore, useAccountList } from '../app/portfolio.ts';
import { useConnection } from '../app/runtimeContext.ts';
import { useTopicEffect } from '../app/useTopic.ts';
import { copyStore } from '../accounts/copy.ts';
import { useRoutedAccount } from '../markets/useRoutes.ts';
import { useLayouts } from '../state/layouts.ts';
import { ticketAccountId, ticketOf, ticketsStore } from '../state/tickets.ts';
import { useUi } from '../state/ui.ts';
import { useWorkspace } from '../state/workspace.ts';
import { isFinancialDraft } from './marks.ts';
import { ShellDataContext, type ShellData } from './shellData.ts';
import { patch, useStore } from '../app/store.ts';

const NO_ACCOUNTS: TradingAccount[] = [];

export function ShellDataProvider({ children }: { children: ReactNode }) {
  const helloEnv = useConnection().server?.environment ?? null;
  const accounts = useAccountList() ?? NO_ACCOUNTS;
  const startWith = useUi((s) => s.tradeAccount);
  const active = useWorkspace((s) => s.activeChart);
  const activeTile = active?.tileId ?? null;
  const own = useStore(ticketsStore, (s) => (activeTile ? ticketOf(s.tickets, activeTile).accountId : null));
  const instrument = useLayouts((s) =>
    active ? (s.layouts[active.layoutId]?.charts[active.tileId]?.instrument ?? null) : null,
  );
  const routed = useRoutedAccount(instrument);
  const positionsKnown = useStore(positionsStore, (p) => p !== null);
  const orders = useOpenOrders();
  const drafts = useAnalyst((st) => (st.approvals ?? []).filter(isFinancialDraft).length);
  const health = useStore(healthStore);
  useTopicEffect('copy.groups', {}, (u) => patch(copyStore, { groups: u.groups }));
  useTopicEffect('copy.sync', {}, (u) => patch(copyStore, { sync: u }));
  const value = useMemo((): ShellData => {
    const accountId = ticketAccountId(accounts, own, routed, startWith);
    return {
      env: accounts.find((a) => a.id === accountId)?.environment ?? helloEnv,
      accounts,
      accountId,
      allOrders: orders ?? [],
      tradingKnown: positionsKnown && orders !== null,
      drafts,
      providers: health?.providers ?? [],
    };
  }, [helloEnv, accounts, own, routed, startWith, positionsKnown, orders, drafts, health]);
  return <ShellDataContext.Provider value={value}>{children}</ShellDataContext.Provider>;
}
