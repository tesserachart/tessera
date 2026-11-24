import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { animationFrame, type FrameScheduler } from './frame.ts';
import { useSight, type Sight } from './inSight.ts';
import { sayFailed } from '../workspace/dock/deskToasts.ts';

export interface Readable<S> {
  readonly getState: () => S;
  readonly subscribe: (listener: (state: S, previous: S) => void) => () => void;
}

export type Store<S> = StoreApi<S>;

export function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const NOT_SAVED = 'View settings could not be saved';

export interface Persist<S> {
  readonly key: string;
  readonly version: number;
  readonly fields: { readonly [K in keyof S]?: z.ZodType<S[K]> };
  readonly migrate?: ((stored: unknown, version: number) => unknown) | undefined;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
}

export interface StoreOptions<S> {
  readonly persist?: Persist<S> | undefined;
}

function lazy<S>(make: () => StoreApi<S>): StoreApi<S> {
  let store: StoreApi<S> | null = null;
  const get = () => (store ??= make());
  return {
    getState: () => get().getState(),
    getInitialState: () => get().getInitialState(),
    setState: (partial: S, replace?: boolean) => {
      get().setState(partial, replace as true);
    },
    subscribe: (listener) => get().subscribe(listener),
  };
}

export function makeStore<S extends object>(initial: S, options: StoreOptions<S> = {}): Store<S> {
  const { persist } = options;
  if (!persist) return createStore<S>()(() => initial);
  const storage = persist.storage === undefined ? defaultStorage() : persist.storage;
  const fields = Object.entries(persist.fields as Record<string, z.ZodType>);

  const load = (): S => {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(persist.key) ?? null;
    } catch (err) {
      console.warn(`[store] ${persist.key} not read; defaults used`, err);
    }
    if (raw === null) return initial;
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      console.warn(`[store] ${persist.key} unreadable; defaults used`, err);
      return initial;
    }
    const { state, version } = (envelope ?? {}) as { state?: unknown; version?: unknown };
    const stored =
      typeof version === 'number' && version !== persist.version && persist.migrate
        ? persist.migrate(state, version)
        : state;
    if (!stored || typeof stored !== 'object') return initial;
    const out = { ...initial } as Record<string, unknown>;
    for (const [key, schema] of fields) {
      if (!(key in stored)) continue;
      const value = schema.safeParse((stored as Record<string, unknown>)[key]);
      if (value.success) out[key] = value.data;
    }
    return out as S;
  };

  let failing = false;
  const save = (value: S) => {
    const state = Object.fromEntries(fields.map(([key]) => [key, (value as Record<string, unknown>)[key]]));
    try {
      storage?.setItem(persist.key, JSON.stringify({ state, version: persist.version }));
      failing = false;
    } catch (err) {
      if (failing) return;
      failing = true;
      sayFailed(NOT_SAVED, err);
    }
  };

  return lazy(() => {
    const store = createStore<S>()(load);
    store.subscribe((value) => {
      save(value);
    });
    return store;
  });
}

export function read<S>(store: Readable<S>): S {
  return store.getState();
}

export function write<S>(store: Store<S>, value: S): void {
  store.setState(value, true);
}

export function patch<S extends object>(store: Store<S>, change: Partial<S> | ((state: S) => Partial<S>)): void {
  store.setState((state) => ({ ...state, ...(typeof change === 'function' ? change(state) : change) }), true);
}

export function watch<S>(store: Readable<S>, listener: (state: S, previous: S) => void): () => void {
  return store.subscribe(listener);
}

export function derived<S, T>(source: Readable<S>, pick: (state: S) => T): Readable<T> {
  let last: { state: S; value: T } | undefined;
  const get = (): T => {
    const state = source.getState();
    if (!last || !Object.is(last.state, state)) last = { state, value: pick(state) };
    return last.value;
  };
  return {
    getState: get,
    subscribe: (listener) => {
      let previous = get();
      return source.subscribe(() => {
        const value = get();
        if (Object.is(value, previous)) return;
        const before = previous;
        previous = value;
        listener(value, before);
      });
    },
  };
}

export function perFrame<S>(source: Readable<S>, frame: FrameScheduler = animationFrame): Readable<S> {
  const listeners = new Set<(state: S, previous: S) => void>();
  let shown = source.getState();
  let off: (() => void) | null = null;
  let cancel: (() => void) | null = null;
  const flush = () => {
    cancel = null;
    const next = source.getState();
    if (Object.is(next, shown)) return;
    const previous = shown;
    shown = next;
    for (const l of [...listeners]) l(next, previous);
  };
  return {
    getState: () => source.getState(),
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        shown = source.getState();
        off = source.subscribe(() => {
          cancel ??= frame(flush);
        });
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        off?.();
        off = null;
        cancel?.();
        cancel = null;
      };
    },
  };
}

export function useStore<S>(store: Readable<S>): S;
export function useStore<S, T>(store: Readable<S>, select: (state: S) => T): T;
export function useStore<S, T>(store: Readable<S>, select?: (state: S) => T): S | T {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(() => onChange()), [store]);
  return useSyncExternalStore(subscribe, usePick(store, select));
}

/** useSyncExternalStore re-renders forever when its snapshot is a new object for the same state. */
function usePick<S, T>(store: Readable<S>, select?: (state: S) => T): () => S | T {
  const pick = useMemo(() => {
    let last: { state: S; value: S | T } | undefined;
    return (state: S): S | T => {
      if (!last || !Object.is(last.state, state)) last = { state, value: select ? select(state) : state };
      return last.value;
    };
  }, [select]);
  return () => pick(store.getState());
}

export function useStoreInSight<S, T>(store: Readable<S>, select: (state: S) => T): T {
  const sight: Sight = useSight();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const off = store.subscribe(() => {
        if (sight.get()) onChange();
      });
      const offSight = sight.subscribe(() => {
        if (sight.get()) onChange();
      });
      return () => {
        off();
        offSight();
      };
    },
    [store, sight],
  );
  return useSyncExternalStore(subscribe, usePick(store, select)) as T;
}
