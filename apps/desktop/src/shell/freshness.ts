import type { ConnectionStatus } from '@tessera/protocol';
import { TRUST_MS } from '@tessera/ui';
import { useMemo } from 'react';
import { behindStore } from '../app/connection.ts';
import { pricesDownStore } from '../app/health.ts';
import { useConnection } from '../app/runtimeContext.ts';
import { useStore } from '../app/store.ts';

export interface Feeds {
  readonly link: { readonly status: ConnectionStatus; readonly everConnected: boolean };
  readonly behindMs: number;
  readonly pricesDown: readonly string[];
}

export interface Stale {
  readonly trust: 'behind' | 'stale';
  readonly words: string;
}

export interface ReadoutStale {
  readonly position: Stale | null;
  readonly prices: Stale | null;
}

const BEHIND_STEPS_MS = [TRUST_MS.disarm, 5_000, 10_000, 20_000, 30_000, 45_000] as const;
const MINUTE_MS = 60_000;

function behindStep(ms: number): number {
  if (ms >= MINUTE_MS) return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return BEHIND_STEPS_MS.filter((step) => ms >= step).at(-1) ?? 0;
}

function behindWords(stepMs: number): string {
  return stepMs >= MINUTE_MS ? `${String(stepMs / MINUTE_MS)} min behind` : `${String(stepMs / 1000)} s behind`;
}

export function streamStale(f: Feeds): Stale | null {
  if (f.link.everConnected && f.link.status !== 'open') return { trust: 'stale', words: 'Runtime dropped' };
  const step = behindStep(f.behindMs);
  return step === 0 ? null : { trust: 'behind', words: behindWords(step) };
}

export function pricesDown(f: Feeds, provider: string | null): boolean {
  return provider !== null && f.pricesDown.includes(provider);
}

export function pricesStale(f: Feeds, provider: string | null): Stale | null {
  const stream = streamStale(f);
  if (stream) return stream;
  return pricesDown(f, provider) ? { trust: 'stale', words: 'No live prices' } : null;
}

export function useFeeds(): Feeds {
  const { status, everConnected } = useConnection();
  const behindMs = useStore(behindStore, behindStep);
  const pricesDown = useStore(pricesDownStore);
  return useMemo(
    () => ({ link: { status, everConnected }, behindMs, pricesDown }),
    [status, everConnected, behindMs, pricesDown],
  );
}
