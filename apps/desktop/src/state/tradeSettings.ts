import type { JsonValue } from '@tessera/protocol';
import { patch, makeStore, useStore } from '../app/store.ts';
import { LEVELS, type LevelSettings } from '../chart/levelSettings.ts';
import type { OcoConfig } from '../shell/oco.ts';
import { writeSetting } from './runtimeSettings.ts';

export interface TradeSettingsState {
  lastOco: Record<string, OcoConfig>;
}

export function ocoKey(accountId: string, root: string): string {
  return `${accountId}|${root}`;
}

export const tradeSettingsStore = makeStore<TradeSettingsState>({ lastOco: {} });

export function useTradeSettings<T>(selector: (s: TradeSettingsState) => T): T {
  return useStore(tradeSettingsStore, selector);
}

export function rememberOco(key: string, oco: OcoConfig): void {
  patch(tradeSettingsStore, (s) => ({ lastOco: { ...s.lastOco, [key]: oco } }));
}

export function setLevels(levels: LevelSettings): void {
  writeSetting(LEVELS.key, levels as unknown as JsonValue).catch((err: unknown) => {
    console.warn(`[settings] ${LEVELS.key} not saved`, err);
  });
}
