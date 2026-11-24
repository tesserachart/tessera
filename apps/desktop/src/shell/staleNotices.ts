import type { ProviderHealth } from '@tessera/protocol';
import type { ToastQueue } from '@tessera/ui';
import { useEffect, useMemo, useRef } from 'react';
import { healthWords } from '../accounts/connections.ts';
import { healthStore } from '../app/health.ts';
import { useStore } from '../app/store.ts';
import { deskToasts } from '../workspace/dock/deskToasts.ts';
import { useFeeds, type Feeds } from './freshness.ts';

export interface StaleNotice {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

const NO_PROVIDERS: readonly ProviderHealth[] = [];

const RUNTIME_DROPPED: StaleNotice = { key: 'stale:runtime', title: 'Runtime dropped', detail: 'Reconnecting' };

function droppedWords(p: ProviderHealth): string | null {
  if (p.status === 'degraded') return 'Reconnecting. New market orders wait for live prices';
  if (p.status === 'down') return p.message?.trim() || p.connection ? healthWords(p) : 'No live prices';
  return null;
}

export function staleNotices(f: Feeds, providers: readonly ProviderHealth[]): StaleNotice[] {
  if (f.link.everConnected && f.link.status !== 'open')
    return f.link.status === 'reconnecting' || f.link.status === 'connecting' ? [RUNTIME_DROPPED] : [];
  return f.pricesDown.flatMap((id) => {
    const p = providers.find((h) => h.providerId === id && h.kind === 'market_data');
    const detail = p ? droppedWords(p) : null;
    return p && detail ? [{ key: `stale:prices:${id}`, title: `${p.displayName} dropped`, detail }] : [];
  });
}

export function showStaleNotices(queue: ToastQueue, shown: Map<string, string>, next: readonly StaleNotice[]): void {
  const wanted = new Set(next.map((n) => n.key));
  for (const key of [...shown.keys()]) {
    if (wanted.has(key)) continue;
    shown.delete(key);
    queue.dismiss(key);
  }
  for (const n of next) {
    const said = `${n.title}\n${n.detail}`;
    if (shown.get(n.key) === said) continue;
    shown.set(n.key, said);
    queue.push({ tone: 'info', key: n.key, title: n.title, detail: n.detail, ms: null });
  }
}

export function useStaleNotices(): void {
  const feeds = useFeeds();
  const providers = useStore(healthStore, (h) => h?.providers ?? NO_PROVIDERS);
  const notices = useMemo(() => staleNotices(feeds, providers), [feeds, providers]);
  const shown = useRef(new Map<string, string>());
  useEffect(() => showStaleNotices(deskToasts, shown.current, notices), [notices]);
  useEffect(() => {
    const mine = shown.current;
    return () => showStaleNotices(deskToasts, mine, []);
  }, []);
}
