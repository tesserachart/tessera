import type { Quote } from '@tessera/protocol';
import { useCallback, useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import { useSight } from '../app/inSight.ts';
import { animationFrame, type FrameScheduler } from '../app/frame.ts';
import { Lifetime } from '../app/lifetime.ts';

const QUOTES_KEEP_MS = 60_000;

export class QuoteStore {
  private readonly quotes = new Map<string, Quote>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly allListeners = new Set<() => void>();
  private readonly interest = new Map<string, number>();
  private readonly lingering = new Map<string, ReturnType<typeof setTimeout>>();
  private subscription = new Lifetime();
  private subscribedKey = '';
  private scheduled = false;
  private readonly frame: FrameScheduler;
  private readonly keepMs: number;
  private readonly dirty = new Set<string>();
  private cancelFrame: (() => void) | null = null;

  constructor(options: { frame?: FrameScheduler; keepMs?: number } = {}) {
    this.frame = options.frame ?? animationFrame;
    this.keepMs = options.keepMs ?? 0;
  }

  get(instrument: string): Quote | undefined {
    return this.quotes.get(instrument);
  }

  watch(instrument: string): () => void {
    const kept = this.lingering.get(instrument);
    if (kept !== undefined) {
      clearTimeout(kept);
      this.lingering.delete(instrument);
    }
    this.interest.set(instrument, (this.interest.get(instrument) ?? 0) + 1);
    if (kept === undefined) this.schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.interest.get(instrument) ?? 1) - 1;
      if (n > 0) {
        this.interest.set(instrument, n);
        return;
      }
      if (this.keepMs <= 0) {
        this.interest.delete(instrument);
        this.schedule();
        return;
      }
      this.interest.set(instrument, 0);
      this.lingering.set(
        instrument,
        setTimeout(() => {
          this.lingering.delete(instrument);
          this.interest.delete(instrument);
          this.schedule();
        }, this.keepMs),
      );
    };
  }

  listen(instrument: string, cb: () => void): () => void {
    let set = this.listeners.get(instrument);
    if (!set) {
      set = new Set();
      this.listeners.set(instrument, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  listenAll(cb: () => void): () => void {
    this.allListeners.add(cb);
    return () => {
      this.allListeners.delete(cb);
    };
  }

  get subscribed(): string[] {
    return this.subscribedKey ? this.subscribedKey.split('\n') : [];
  }

  flush(): void {
    this.scheduled = false;
    const wanted = [...this.interest.keys()].sort();
    const key = wanted.join('\n');
    if (key === this.subscribedKey) return;
    const last = this.subscription;
    this.subscription = new Lifetime();
    this.subscribedKey = key;
    if (wanted.length > 0) this.follow(wanted);
    last.end();
  }

  private follow(instruments: string[]): void {
    this.subscription.topic(
      'market.quotes',
      { instruments },
      (e) => {
        if (e._tag === 'Event') this.apply(e.data);
        else if (e._tag === 'Refused' || e._tag === 'Ended') console.warn(`[quotes] ${e.error.message}`);
      },
      { invalid: 'log' },
    );
  }

  apply(q: Quote): void {
    this.quotes.set(q.instrument, q);
    if (!this.listeners.get(q.instrument)?.size && this.allListeners.size === 0) return;
    this.dirty.add(q.instrument);
    this.cancelFrame ??= this.frame(() => {
      this.notifyNow();
    });
  }

  notifyNow(): void {
    this.cancelFrame?.();
    this.cancelFrame = null;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const set = this.listeners.get(id);
      if (set) for (const cb of [...set]) cb();
    }
    if (ids.length > 0) for (const cb of [...this.allListeners]) cb();
  }

  dispose(): void {
    for (const t of this.lingering.values()) clearTimeout(t);
    this.lingering.clear();
    this.subscription.end();
    this.subscribedKey = '';
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.dirty.clear();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      if (this.scheduled) this.flush();
    });
  }
}

export const quoteStore = new QuoteStore({ keepMs: QUOTES_KEEP_MS });

export function useQuote(instrument: string | null): Quote | undefined {
  const sight = useSight();
  useEffect(() => (instrument ? quoteStore.watch(instrument) : undefined), [instrument]);
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!instrument) return () => undefined;
      const offQuotes = quoteStore.listen(instrument, () => {
        if (sight.get()) cb();
      });
      const offSight = sight.subscribe(() => {
        if (sight.get()) cb();
      });
      return () => {
        offQuotes();
        offSight();
      };
    },
    [instrument, sight],
  );
  const snapshot = useCallback(() => (instrument ? quoteStore.get(instrument) : undefined), [instrument]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function useQuoteReader(instrument: string | null, changed: () => void): () => Quote | undefined {
  const onChange = useEffectEvent(changed);
  useEffect(() => (instrument ? quoteStore.watch(instrument) : undefined), [instrument]);
  useEffect(() => (instrument ? quoteStore.listen(instrument, () => onChange()) : undefined), [instrument]);
  return useCallback(() => (instrument ? quoteStore.get(instrument) : undefined), [instrument]);
}

export function useQuoteSource(instrument: string | null): string | null {
  useEffect(() => (instrument ? quoteStore.watch(instrument) : undefined), [instrument]);
  const subscribe = useCallback(
    (cb: () => void) => (instrument ? quoteStore.listen(instrument, cb) : () => undefined),
    [instrument],
  );
  const source = useCallback(
    () => (instrument ? (quoteStore.get(instrument)?.source?.provider ?? null) : null),
    [instrument],
  );
  return useSyncExternalStore(subscribe, source);
}

export function quoteChange(q: Quote | undefined): { change: number | null; pct: number | null } {
  const last = q?.last ?? null;
  const prev = q?.session?.prevClose ?? null;
  if (last === null || prev === null || prev === 0) return { change: null, pct: null };
  const change = last - prev;
  return { change, pct: (change / prev) * 100 };
}
