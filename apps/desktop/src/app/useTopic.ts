import { Runtime, type EventMeta, type TopicName } from '@tessera/protocol';
import { useEffect, useEffectEvent } from 'react';
import { appClient } from './services.ts';
import type { TopicData, TopicParams } from './topics.ts';

export interface TopicEffectOptions {
  readonly onResubscribed?: () => void;
  readonly onActive?: () => void;
  readonly replay?: boolean;
}

export function useTopicEffect<T extends TopicName>(
  topic: T,
  params: TopicParams<T> | null,
  handler: (data: TopicData<T>, meta: EventMeta) => void,
  options?: TopicEffectOptions,
): void {
  const onEvent = useEffectEvent(handler);
  const onResubscribed = useEffectEvent(() => options?.onResubscribed?.());
  const onActive = useEffectEvent(() => options?.onActive?.());
  const key = params === null ? null : JSON.stringify(params);
  const replay = options?.replay;
  useEffect(() => {
    if (key === null) return;
    return Runtime.topic(
      appClient(),
      topic,
      JSON.parse(key) as TopicParams<T>,
      (e) => {
        if (e._tag === 'Refused' || e._tag === 'Ended') console.warn(`[topic ${topic}] ${e.error.message}`);
        else if (e._tag === 'Event') onEvent(e.data, e.meta);
        else if (e._tag === 'Active') onActive();
        else if (e._tag === 'Resubscribed') onResubscribed();
      },
      { invalid: 'log', ...(replay === undefined ? {} : { replay }) },
    );
  }, [topic, key, replay]);
}
