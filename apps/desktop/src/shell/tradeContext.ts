import type { AccountUpdate, ContractSpec } from '@tessera/protocol';
import { ocoKey, useTradeSettings, type TradeSettingsState, rememberOco } from '../state/tradeSettings.ts';
import {
  DEFAULT_OCO,
  contractMath,
  instrumentRoot,
  knownContract,
  type ContractMath,
  type OcoConfig,
  type OcoMarket,
} from './oco.ts';

export function resolveOco(s: Pick<TradeSettingsState, 'lastOco'>, accountId: string, root: string): OcoConfig {
  return s.lastOco[ocoKey(accountId, root)] ?? DEFAULT_OCO;
}

export function useOco(
  accountId: string | null,
  root: string | null,
): {
  saved: OcoConfig;
  oco: OcoConfig;
  set: (oco: OcoConfig) => void;
} {
  const saved = useTradeSettings((s) => (accountId && root ? resolveOco(s, accountId, root) : DEFAULT_OCO));
  return {
    saved,
    oco: saved,
    set: (oco) => {
      if (accountId && root) rememberOco(ocoKey(accountId, root), oco);
    },
  };
}

export function mathOf(spec: ContractSpec | null, instrument: string | null): ContractMath | null {
  if (spec) return contractMath(spec);
  return instrument ? knownContract(instrumentRoot(instrument)) : null;
}

export function ocoMarket(math: ContractMath | null, qty: number, update: AccountUpdate | null): OcoMarket | null {
  if (!math) return null;
  return { ...math, qty, balance: update?.summary.netLiq.amount ?? null };
}
