import { z } from 'zod';
import { patch, read, makeStore, useStore } from '../app/store.ts';

const AREA_IDS = [
  'desk',
  'markets',
  'agents',
  'indicators',
  'research',
  'journal',
  'copy',
  'settings',
  'profile',
] as const;
export type AreaId = (typeof AREA_IDS)[number];

export function isAreaId(v: unknown): v is AreaId {
  return typeof v === 'string' && (AREA_IDS as readonly string[]).includes(v);
}

interface AreaState {
  area: AreaId;
  previous: AreaId | null;
}

export const areaStore = makeStore<AreaState>(
  { area: 'desk', previous: null },
  { persist: { key: 'tessera.area', version: 1, fields: { area: z.enum(AREA_IDS) } } },
);

export const useArea = <T>(pick: (s: AreaState) => T): T => useStore(areaStore, pick);

export function showArea(area: AreaId): void {
  const { area: shown } = read(areaStore);
  if (shown !== area) patch(areaStore, { area, previous: shown });
}

export function showPreviousArea(): void {
  const { area, previous } = read(areaStore);
  showArea(previous && previous !== area ? previous : 'desk');
}
