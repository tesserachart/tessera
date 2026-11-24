import type { ChartLayer, CustomIndicator, IndicatorSpec, SeriesError } from '@tessera/protocol';
import { useEffect } from 'react';
import { Lifetime } from '../app/lifetime.ts';
import { patch, read, makeStore, useStore } from '../app/store.ts';

export const CUSTOM_KIND = 'custom' as const;

export type CustomCatalog = Readonly<Record<string, CustomIndicator>>;

interface CustomState {
  byId: CustomCatalog;
  list: readonly CustomIndicator[];
  loaded: boolean;
  problems: Readonly<Record<string, SeriesError>>;
}

export const customStore = makeStore<CustomState>({ byId: {}, list: [], loaded: false, problems: {} });

export function setCatalog(list: readonly CustomIndicator[]): void {
  patch(customStore, { list, byId: Object.fromEntries(list.map((c) => [c.id, c])), loaded: true });
}

export function putCustom(c: CustomIndicator): void {
  const { list } = read(customStore);
  const next = list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c];
  setCatalog(next);
}

export function customIndicator(id: string): CustomIndicator | null {
  return read(customStore).byId[id] ?? null;
}

export function customRef(params: unknown): string | null {
  const id = params && typeof params === 'object' ? (params as Record<string, unknown>).indicator : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function customLayerSpec(
  layer: ChartLayer,
  catalog: CustomCatalog = read(customStore).byId,
): IndicatorSpec | null {
  const id = customRef(layer.params);
  return id ? (catalog[id]?.spec ?? null) : null;
}

export function setProblem(layerId: string, problem: SeriesError | null): void {
  const { problems } = read(customStore);
  if (!problem && !(layerId in problems)) return;
  const current = problems[layerId];
  if (problem && current?.message === problem.message && current.line === problem.line) return;
  const next = Object.fromEntries(Object.entries(problems).filter(([k]) => k !== layerId));
  if (problem) next[layerId] = problem;
  patch(customStore, { problems: next });
}

export function problemOf(layerId: string): SeriesError | null {
  return read(customStore).problems[layerId] ?? null;
}

const catalog = new Lifetime();
let holders = 0;

function followCatalog(): void {
  catalog.topic(
    'indicators.catalog',
    {},
    (e) => {
      if (e._tag === 'Event') setCatalog(e.data.custom);
      else if (e._tag === 'Refused' || e._tag === 'Ended') console.warn(`[indicators.catalog] ${e.error.message}`);
    },
    { invalid: 'log' },
  );
}

export function retainCatalog(): () => void {
  if (holders++ === 0) followCatalog();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0) catalog.end();
  };
}

function useRetainedCatalog(): void {
  useEffect(() => retainCatalog(), []);
}

export function useCustomIndicators(): readonly CustomIndicator[] {
  useRetainedCatalog();
  return useStore(customStore, (s) => s.list);
}

export function useCustomCatalog(): CustomCatalog {
  useRetainedCatalog();
  return useStore(customStore, (s) => s.byId);
}

export function useCatalogLoaded(): boolean {
  return useStore(customStore, (s) => s.loaded);
}
