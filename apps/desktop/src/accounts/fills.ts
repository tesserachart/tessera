import type { Fill } from '@tessera/protocol';
import { refreshTools, useHasTool, useTool, valueOf } from '../app/tools.ts';
import { useTopicEffect } from '../app/useTopic.ts';

export function useTodaysFills(): Fill[] | null {
  const has = useHasTool('portfolio.get_fills');
  const q = useTool('portfolio.get_fills', has ? {} : null, { keepFor: Infinity });
  useTopicEffect('fills', has ? {} : null, () => void refreshTools('portfolio.get_fills'));
  const fills = valueOf(q)?.fills;
  if (!has || q.isError) return fills ?? [];
  return fills ?? null;
}
