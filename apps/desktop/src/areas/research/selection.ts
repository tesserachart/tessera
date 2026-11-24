import { patch, makeStore, useStore } from '../../app/store.ts';

interface ResearchView {
  selected: string | null;
  fresh: boolean;
}

export const researchViewStore = makeStore<ResearchView>({ selected: null, fresh: false });

export function useResearchView<T>(pick: (s: ResearchView) => T): T {
  return useStore(researchViewStore, pick);
}

export function selectStudy(id: string | null): void {
  patch(researchViewStore, { selected: id, fresh: false });
}

export function startStudy(): void {
  patch(researchViewStore, { fresh: true });
}
