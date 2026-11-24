import type { JsonValue } from '@tessera/protocol';
import { createEchoGuard } from '../app/echoGuard.ts';
import { patch, read, makeStore, useStore } from '../app/store.ts';
import { failureText, runTool } from '../app/tools.ts';

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
}

export async function writeSetting(key: string, value: JsonValue, options: WriteOptions = {}): Promise<JsonValue> {
  const { merge = false, refresh } = options;
  if (merge) {
    const out = await runTool('settings.set', { key, value }, refresh ? { refresh } : {});
    return out.value;
  }
  show(key, value);
  const done = guard.write(key, value);
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

export function useRuntimeSetting(key: string): unknown {
  return useStore(runtimeSettingsStore, (s) => s.values[key]);
}

export function useRuntimeSettingsLoaded(): boolean {
  return useStore(runtimeSettingsStore, (s) => s.loaded);
}

export async function setRuntimeSetting(key: string, value: JsonValue): Promise<string | null> {
  try {
    await writeSetting(key, value, { refresh: ['settings.get'] });
    return null;
  } catch (e) {
    return refusal(key, failureText(e));
  }
}

function refusal(key: string, message: string | undefined): string {
  const m = (message ?? 'It did not go through.').replace(new RegExp(`^${key.replace(/\./g, '\\.')}: `), '');
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export function useSetSetting(): (key: string, value: JsonValue) => Promise<string | null> {
  return setRuntimeSetting;
}
