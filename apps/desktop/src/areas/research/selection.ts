import { patch, makeStore, useStore } from '../../app/store.ts';
import type { Shelf } from './ledger.ts';

export type RunTab = 'overview' | 'trades' | 'setup';

interface ResearchView {
  selected: string | null;
  shelf: Shelf;
  query: string;
  tab: RunTab;
  trade: number | null;
}

export const researchViewStore = makeStore<ResearchView>({
  selected: null,
  shelf: 'active',
  query: '',
  tab: 'overview',
  trade: null,
});

export function useResearchView<T>(pick: (s: ResearchView) => T): T {
  return useStore(researchViewStore, pick);
}

export function selectStudy(id: string | null): void {
  patch(researchViewStore, { selected: id, trade: null });
}

export function showRunTrade(runId: string, trade: number): void {
  patch(researchViewStore, { selected: runId, tab: 'trades', trade, shelf: 'active', query: '' });
}

export const setShelf = (shelf: Shelf) => patch(researchViewStore, { shelf });
export const setQuery = (query: string) => patch(researchViewStore, { query });
export const setRunTab = (tab: RunTab) => patch(researchViewStore, { tab });
export const pickTrade = (trade: number | null) => patch(researchViewStore, { trade });
