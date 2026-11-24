import type { Level, LevelsUpdate } from '@tessera/protocol';
import { useMemo, useState } from 'react';
import { useTopicEffect } from '../app/useTopic.ts';

export function useChartLevels(instrument: string | null): readonly Level[] {
  const [state, setState] = useState<{ instrument: string | null; byProvider: Map<string, LevelsUpdate> }>({
    instrument,
    byProvider: new Map(),
  });
  const params = instrument ? { instrument } : null;
  const put = (topic: string) => (update: LevelsUpdate) => {
    setState((prev) => {
      const fresh = prev.instrument === instrument ? prev.byProvider : new Map<string, LevelsUpdate>();
      const next = new Map(fresh);
      next.set(`${topic}:${update.provider}`, update);
      return { instrument, byProvider: next };
    });
  };
  useTopicEffect('intel.levels', params, put('intel'));
  useTopicEffect('concepts.levels', params, put('concepts'));
  const current = state.instrument === instrument ? state.byProvider : null;
  return useMemo(
    () =>
      current ? [...current.entries()].sort(([a], [b]) => byTopicThenProvider(a, b)).flatMap(([, u]) => u.levels) : [],
    [current],
  );
}

function byTopicThenProvider(a: string, b: string): number {
  const rank = (key: string) => (key.startsWith('intel:') ? 0 : 1);
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}
