import { derived, type Readable } from './store.ts';
import { topicLatest, type TopicData } from './topics.ts';

const NONE: readonly string[] = [];

export const healthStore: Readable<TopicData<'health'> | null> = topicLatest('health', {});

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function steadyPricesDown(): (health: TopicData<'health'> | null) => readonly string[] {
  let last = NONE;
  return (health) => {
    const next = health?.pricesDown ?? NONE;
    if (!sameList(next, last)) last = next;
    return last;
  };
}

export const pricesDownStore: Readable<readonly string[]> = derived(healthStore, steadyPricesDown());

function steadyServing(): (health: TopicData<'health'> | null) => readonly string[] {
  let last = NONE;
  return (health) => {
    const down = health?.pricesDown ?? NONE;
    const next = (health?.providers ?? [])
      .filter((p) => p.kind === 'market_data' && (p.status === 'ok' || p.status === 'degraded'))
      .map((p) => p.providerId)
      .filter((id) => !down.includes(id))
      .sort();
    if (!sameList(next, last)) last = next;
    return last;
  };
}

const servingMarketsStore: Readable<readonly string[]> = derived(healthStore, steadyServing());

export function onMarketServed(listener: () => void): () => void {
  return servingMarketsStore.subscribe((now, before) => {
    if (now.some((id) => !before.includes(id))) listener();
  });
}
