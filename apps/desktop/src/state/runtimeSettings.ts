import type { JsonValue } from '@tessera/protocol';
import { createEchoGuard } from '../app/echoGuard.ts';
import { useCallback, useState } from 'react';
import { patch, read, makeStore, useStore, watch } from '../app/store.ts';
import { DID_NOT_GO_THROUGH, failureText, runTool, useHasTool, useToolValue } from '../app/tools.ts';
import type { Setting } from './setting.ts';

interface RuntimeSettingsState {
  values: Readonly<Record<string, unknown>>;
  loaded: boolean;
}

export const runtimeSettingsStore = makeStore<RuntimeSettingsState>({ values: {}, loaded: false });

const guard = createEchoGuard();
const held = new Map<string, unknown>();
const heard = new Map<string, number>();

export function receiveSettings(
  values: Readonly<Record<string, unknown>>,
  snapshot: boolean,
  localOf: (key: string) => unknown = () => undefined,
): Record<string, unknown> {
  const shown = read(runtimeSettingsStore).values;
  const admitted: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    held.set(key, value);
    heard.set(key, (heard.get(key) ?? 0) + 1);
    const own = localOf(key);
    if (guard.admit(key, value, own === undefined ? shown[key] : own)) admitted[key] = value;
    else if (key in shown) kept[key] = shown[key];
  }
  patch(runtimeSettingsStore, (s) => ({
    values: snapshot ? { ...values, ...kept } : { ...s.values, ...admitted },
    loaded: true,
  }));
  return admitted;
}

export function settingAgreed(key: string): string | undefined {
  return guard.agreed(key);
}

export function putRuntimeSettings(values: Readonly<Record<string, unknown>>, snapshot: boolean): void {
  receiveSettings(values, snapshot);
}

export function answerFor(key: string): () => boolean {
  const at = heard.get(key) ?? 0;
  return () => (heard.get(key) ?? 0) === at;
}

function show(key: string, value: unknown): void {
  patch(runtimeSettingsStore, (s) => ({ values: { ...s.values, [key]: value } }));
}

export interface WriteOptions {
  refresh?: string[];
  merge?: boolean;
  shown?: JsonValue;
}

export async function writeSetting(key: string, value: JsonValue, options: WriteOptions = {}): Promise<JsonValue> {
  const { merge = false, refresh } = options;
  if (merge) {
    const out = await runTool('settings.set', { key, value }, refresh ? { refresh } : {});
    return out.value;
  }
  const optimistic = options.shown ?? value;
  show(key, optimistic);
  const done = guard.write(key, optimistic);
  try {
    const out = await runTool('settings.set', { key, value }, refresh ? { refresh } : {});
    if (done(out.value)) show(key, out.value);
    return out.value;
  } catch (e) {
    const back = held.get(key) ?? null;
    if (done(back)) show(key, back);
    throw e;
  }
}

export function useSettingInfos() {
  const has = useHasTool('settings.get');
  return useToolValue('settings.get', has ? {} : null, { keepFor: Infinity })?.settings ?? null;
}

export function readSetting<T>(setting: Setting<T>): T {
  return setting.read(read(runtimeSettingsStore).values[setting.key]);
}

export function useSetting<T>(setting: Setting<T>): T {
  return useStore(runtimeSettingsStore, (s) => setting.read(s.values[setting.key]));
}

export function watchSetting<T>(setting: Setting<T>, listener: (value: T) => void): () => void {
  let last = readSetting(setting);
  return runtimeSettingsStore.subscribe((s) => {
    const value = setting.read(s.values[setting.key]);
    if (Object.is(value, last)) return;
    last = value;
    listener(value);
  });
}

export function useRuntimeSettingsLoaded(): boolean {
  return useStore(runtimeSettingsStore, (s) => s.loaded);
}

export function onceSettingsLoaded(then: () => void): () => void {
  if (read(runtimeSettingsStore).loaded) {
    then();
    return () => undefined;
  }
  const off = watch(runtimeSettingsStore, (s) => {
    if (!s.loaded) return;
    off();
    then();
  });
  return off;
}

export async function saveSetting(
  setting: Setting<unknown>,
  value: JsonValue,
  shown?: JsonValue,
): Promise<string | null> {
  try {
    await writeSetting(setting.key, value, { refresh: ['settings.get'], ...(shown === undefined ? {} : { shown }) });
    return null;
  } catch (e) {
    return refusal(setting.key, failureText(e));
  }
}

function refusal(key: string, message: string): string {
  const m = (message || DID_NOT_GO_THROUGH).replace(new RegExp(`^${key.replace(/\./g, '\\.')}: `), '');
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export interface SettingSave {
  readonly save: (value: JsonValue, shown?: JsonValue) => Promise<string | null>;
  readonly error: string | null;
  readonly clear: () => void;
}

export function useSettingSave(setting: Setting<unknown>): SettingSave {
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (value: JsonValue, shown?: JsonValue) => {
      setError(null);
      const why = await saveSetting(setting, value, shown);
      setError(why);
      return why;
    },
    [setting],
  );
  const clear = useCallback(() => setError(null), []);
  return { save, error, clear };
}
