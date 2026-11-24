import type { JsonValue } from '@tessera/protocol';
import { useEffect } from 'react';
import { everConnectedStore } from '../app/connection.ts';
import { patch, read, makeStore, type Store, useStore } from '../app/store.ts';
import { DEFAULT_LEVEL_SETTINGS, readLevelSettings, type LevelSettings } from '../chart/levelSettings.ts';
import type { OcoConfig } from '../shell/oco.ts';
import { runTool } from '../app/tools.ts';
import { writeSetting as writeRuntimeSetting } from './runtimeSettings.ts';

const SETTING_LEVELS = 'chart.levels';

export interface TradeSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'local';
  lastOco: Record<string, OcoConfig>;
  levels: LevelSettings;
}

export function ocoKey(accountId: string, root: string): string {
  return `${accountId}|${root}`;
}

type Writer = (key: string, value: JsonValue) => void;

function makeTradeSettingsStore(initial: Partial<TradeSettingsState> = {}): Store<TradeSettingsState> {
  return makeStore<TradeSettingsState>({ status: 'idle', lastOco: {}, levels: DEFAULT_LEVEL_SETTINGS, ...initial });
}

export const tradeSettingsStore = makeTradeSettingsStore();

export function useTradeSettings<T>(selector: (s: TradeSettingsState) => T): T {
  return useStore(tradeSettingsStore, selector);
}

let writer: Writer | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function writeSetting(key: string, value: unknown, delay = 0): void {
  if (!writer) return;
  const w = writer;
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  if (delay <= 0) {
    w(key, value as JsonValue);
    return;
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      w(key, value as JsonValue);
    }, delay),
  );
}

function attachWriter(w: Writer | null): void {
  writer = w;
}

export function rememberOco(key: string, oco: OcoConfig): void {
  patch(tradeSettingsStore, (s) => ({ lastOco: { ...s.lastOco, [key]: oco } }));
}

export function setLevels(levels: LevelSettings): void {
  patch(tradeSettingsStore, { levels });
  writeSetting(SETTING_LEVELS, levels);
}

function applyStored(values: Record<string, unknown>): Partial<TradeSettingsState> {
  return { levels: readLevelSettings(values[SETTING_LEVELS]) };
}

async function load(): Promise<void> {
  patch(tradeSettingsStore, { status: 'loading' });
  try {
    const out = await runTool('settings.get', {
      keys: [SETTING_LEVELS],
    });
    const values = Object.fromEntries(Object.entries(out.settings).map(([k, info]) => [k, info.value]));
    patch(tradeSettingsStore, { ...applyStored(values), status: 'ready' });
    attachWriter((key, value) => {
      writeRuntimeSetting(key, value).catch((err: unknown) => {
        console.warn(`[settings] ${key} not saved`, err);
      });
    });
  } catch (err) {
    console.warn('[settings] trade settings unavailable; kept in this window', err);
    patch(tradeSettingsStore, { status: 'local' });
    attachWriter(null);
  }
}

let syncing = false;

function startSync(): void {
  if (syncing) return;
  syncing = true;
  everConnectedStore.subscribe((connected) => {
    if (connected) void load();
  });
  if (read(everConnectedStore)) void load();
}

export function useTradeSettingsSync(): void {
  useEffect(startSync, []);
}
