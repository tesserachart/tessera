import type { ToolName, TradeFilter } from '@tessera/protocol';
import { useMemo } from 'react';
import { useClock } from '../../app/clock.ts';
import { refreshTools, runTool, useHasTool, useTool, type ToolInput, type ToolOutput } from '../../app/tools.ts';
import { useTopicEffect } from '../../app/useTopic.ts';
import { todayIn } from './model/format.ts';
import { scopedFilter } from './model/scope.ts';
import { useJournalUi } from './store.ts';
import { useDisplayZone } from '../../state/timeZone.ts';

const JOURNAL = 'journal.*';

export function useJournalLive(): void {
  const has = useHasTool('journal.get_catalog');
  useTopicEffect('journal.changes', has ? {} : null, (change) => {
    if (change.reason === 'snapshot' || change.reason === 'drawings') return;
    void refreshTools(JOURNAL);
  });
}

export function useJournalAction() {
  return <N extends ToolName>(name: N, input: ToolInput<N>): Promise<ToolOutput<N>> =>
    runTool(name, input, { refresh: [JOURNAL] });
}

export function useCatalog() {
  const has = useHasTool('journal.get_catalog');
  return useTool('journal.get_catalog', has ? {} : null, { keepFor: 60_000 });
}

export function useToday(): string {
  const clock = useClock();
  const zone = useDisplayZone();
  const now = clock.now();
  const day = todayIn(zone, now);
  return useMemo(() => day, [day]);
}

export function useScopedFilter(withFilter: boolean): TradeFilter {
  const scope = useJournalUi((s) => s.scope);
  const filter = useJournalUi((s) => s.filter);
  const today = useToday();
  return useMemo(() => scopedFilter(scope, withFilter ? filter : {}, today), [scope, filter, withFilter, today]);
}

export function useStats(filter: TradeFilter, compact = false) {
  const has = useHasTool('journal.get_stats');
  return useTool('journal.get_stats', has ? { filter, ...(compact ? { compact } : {}) } : null, { keepPrevious: true });
}

export function useTrades(
  filter: TradeFilter,
  sort?: ToolInput<'journal.list_trades'>['sort'],
  ascending?: boolean,
  limit = 500,
) {
  const has = useHasTool('journal.list_trades');
  return useTool(
    'journal.list_trades',
    has ? { filter, ...(sort ? { sort } : {}), ...(ascending ? { ascending } : {}), limit } : null,
    { keepPrevious: true },
  );
}

export function useCalendar(from: string, to: string, filter: TradeFilter) {
  const has = useHasTool('journal.get_calendar');
  return useTool('journal.get_calendar', has ? { from, to, filter } : null, { keepPrevious: true });
}
