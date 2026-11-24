import { useEffect } from 'react';
import { createEchoGuard } from './echoGuard.ts';
import { stableStringify } from './stableJson.ts';
import { makeStore, patch, read, useStore, write, type Store } from './store.ts';

export interface Overlay {
  write(key: string, value: unknown, send: () => Promise<unknown>): Promise<void>;
  edit(key: string, value: unknown): void;
  settle(key: string, server: unknown): void;
  shown<T>(key: string, server: T): T;
  readonly store: Store<Readonly<Record<string, unknown>>>;
}

export function createOverlay(): Overlay {
  const store = makeStore<Readonly<Record<string, unknown>>>({});
  const guard = createEchoGuard();
  const seen = new Map<string, string>();
  const last = new Map<string, unknown>();
  const drop = (key: string) => {
    const s = read(store);
    if (!(key in s)) return;
    const { [key]: _gone, ...rest } = s;
    write(store, rest);
  };
  return {
    store,
    async write(key, value, send) {
      patch(store, (s) => ({ ...s, [key]: value }));
      seen.delete(key);
      const done = guard.write(key, value);
      try {
        await send();
        done();
      } catch (e) {
        if (done()) drop(key);
        throw e;
      }
    },
    edit(key, value) {
      if (guard.agreed(key) === undefined && last.has(key)) guard.agree(key, last.get(key));
      patch(store, (s) => ({ ...s, [key]: value }));
    },
    settle(key, server) {
      const json = stableStringify(server);
      if (seen.get(key) === json) return;
      seen.set(key, json);
      last.set(key, server);
      const edits = read(store);
      if (!(key in edits)) return;
      const mine = edits[key];
      if (guard.admit(key, server, mine) || (!guard.writing(key) && stableStringify(mine) === json)) drop(key);
    },
    shown<T>(key: string, server: T): T {
      const edits = read(store);
      return key in edits ? (edits[key] as T) : server;
    },
  };
}

export function useOverlay(
  overlay: Overlay,
  reads: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const edits = useStore(overlay.store, (s) => s);
  const json = stableStringify(reads);
  useEffect(() => {
    for (const [key, value] of Object.entries(reads)) overlay.settle(key, value);
  }, [overlay, json]);
  return edits;
}

export function useDraft<T>(
  overlay: Overlay,
  key: string | null,
  server: T,
): { value: T; edit: (value: T) => void; save: (value: T, send: (value: T) => Promise<unknown>) => void } {
  const edits = useOverlay(overlay, key ? { [key]: server } : {});
  return {
    value: key && key in edits ? (edits[key] as T) : server,
    edit: (value) => {
      if (key) overlay.edit(key, value);
    },
    save: (value, send) => {
      if (!key) return;
      overlay.write(key, value, () => send(value)).catch(() => undefined);
    },
  };
}
