import { patch, read, makeStore, useStore } from '../app/store.ts';
import type { Placement } from '../chart/placement.ts';

export interface PlacementState {
  placing: Placement | null;
  seq: number;
}

export const placementStore = makeStore<PlacementState>({ placing: null, seq: 0 });

export const startPlacement = (p: Placement) => patch(placementStore, (s) => ({ placing: p, seq: s.seq + 1 }));

export function updatePlacement(seq: number, p: Placement | null): void {
  if (read(placementStore).seq === seq) patch(placementStore, { placing: p });
}

export const endPlacement = () => patch(placementStore, (s) => ({ placing: null, seq: s.seq + 1 }));

export function usePlacement<T>(selector: (s: PlacementState) => T): T {
  return useStore(placementStore, selector);
}
