import { useLoadPending } from '@tessera/ui';
import { healthStore } from '../../app/health.ts';
import { useAccountList } from '../../app/portfolio.ts';
import { useStore } from '../../app/store.ts';
import { useCopyGroups } from '../../accounts/copy.ts';
import { useShellData } from '../../shell/shellData.ts';

function useAccountsKnown(): void {
  useLoadPending(useAccountList() === null);
}

export function useTradingKnown(): void {
  useAccountsKnown();
  useLoadPending(!useShellData().tradingKnown);
}

export function useConnectionsKnown(): void {
  useLoadPending(useStore(healthStore) === null);
  useLoadPending(useCopyGroups() === null);
}
