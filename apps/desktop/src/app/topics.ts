import { Runtime, type TopicMap, type TopicName } from '@tessera/protocol';
import { servicesStore } from './services.ts';
import type { Readable } from './store.ts';

export type TopicData<T extends TopicName> = TopicMap[T]['data'];
export type TopicParams<T extends TopicName> = TopicMap[T]['params'];

export interface TopicFold<S, D> {
  readonly empty: () => S;
  readonly reduce: (state: S, data: D) => S;
}

const KEEP_MS = 400;

export function topicFold<T extends TopicName, S>(
  topic: T,
  params: TopicParams<T>,
  fold: TopicFold<S, TopicData<T>>,
): Readable<S | null> {
  let state: S | null = null;
  const listeners = new Set<(state: S | null, previous: S | null) => void>();
  let stop: (() => void) | null = null;
  let unwatchServices: (() => void) | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const set = (next: S | null) => {
    if (Object.is(next, state)) return;
    const previous = state;
    state = next;
    for (const l of [...listeners]) l(next, previous);
  };

  const subscribeTopic = () => {
    stop?.();
    stop = null;
    set(null);
    const services = servicesStore.getState();
    if (!services) return;
    stop = Runtime.topic(
      services.client,
      topic,
      params,
      (e) => {
        switch (e._tag) {
          case 'Active':
            set(state ?? fold.empty());
            return;
          case 'Resubscribed':
            set(null);
            return;
          case 'Event':
            set(fold.reduce(state ?? fold.empty(), e.data));
            return;
          case 'Ended':
            console.warn(`[topic ${topic}] ${e.error.message}`);
            return;
          case 'Gap':
          case 'Refused':
            return;
        }
      },
      { invalid: 'log' },
    );
  };

  const start = () => {
    if (idle !== null) {
      clearTimeout(idle);
      idle = null;
      return;
    }
    if (unwatchServices) return;
    unwatchServices = servicesStore.subscribe(subscribeTopic);
    subscribeTopic();
  };

  const end = () => {
    idle = null;
    unwatchServices?.();
    unwatchServices = null;
    stop?.();
    stop = null;
    state = null;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        idle = setTimeout(end, KEEP_MS);
      };
    },
  };
}

export function topicLatest<T extends TopicName>(topic: T, params: TopicParams<T>): Readable<TopicData<T> | null> {
  return topicFold(topic, params, { empty: () => null as TopicData<T> | null, reduce: (_, data) => data });
}
