import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

export interface Sight {
  get(): boolean;
  subscribe(changed: () => void): () => void;
}

export class SightSwitch implements Sight {
  private shown: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(shown: boolean) {
    this.shown = shown;
  }

  get(): boolean {
    return this.shown;
  }

  set(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    for (const l of [...this.listeners]) l();
  }

  subscribe(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => {
      this.listeners.delete(changed);
    };
  }
}

export const windowSight: Sight = {
  get: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  subscribe: (changed) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  },
};

const ALWAYS: Sight = { get: () => true, subscribe: () => () => undefined };

export const InSight = createContext<Sight>(ALWAYS);

export function useSight(): Sight {
  return useContext(InSight);
}

export function useInSight(): boolean {
  const sight = useSight();
  const subscribe = useCallback((changed: () => void) => sight.subscribe(changed), [sight]);
  return useSyncExternalStore(subscribe, () => sight.get());
}
