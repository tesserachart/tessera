import type { Environment, Order, ProviderHealth, TradingAccount } from '@tessera/protocol';
import { createContext, useContext } from 'react';

export interface ShellData {
  env: Environment | null;
  accounts: TradingAccount[];
  accountId: string | null;
  allOrders: Order[];
  tradingKnown: boolean;
  drafts: number;
  providers: ProviderHealth[];
}

export const EMPTY_SHELL_DATA: ShellData = {
  env: null,
  accounts: [],
  accountId: null,
  allOrders: [],
  tradingKnown: false,
  drafts: 0,
  providers: [],
};

export const ShellDataContext = createContext<ShellData>(EMPTY_SHELL_DATA);

export function useShellData(): ShellData {
  return useContext(ShellDataContext);
}
