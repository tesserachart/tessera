import type { ChartState, Drawing } from '@tessera/protocol';
import { useMemo } from 'react';
import { displaySymbol, printBarsShort } from '../../market/instruments.ts';
import { useLayouts, type LayoutsState } from '../../state/layouts.ts';
import { drawingsOn } from './model.ts';

type Charts = Readonly<Record<string, ChartState>>;

const NO_DRAWINGS: readonly Drawing[] = [];

export function pickedSources(charts: Charts, tileId: string): string[] {
  return (charts[tileId]?.drawingsFrom ?? []).filter((t) => t !== tileId && t in charts);
}

export function shownDrawings(charts: Charts, tileId: string): Drawing[] {
  const chart = charts[tileId];
  if (!chart) return [];
  const seen = new Set<string>();
  const out: Drawing[] = [];
  for (const home of [tileId, ...pickedSources(charts, tileId)]) {
    for (const d of drawingsOn(charts[home]?.drawings, chart.instrument)) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

export function homeOf(charts: Charts, tileId: string, id: string): string | null {
  for (const home of [tileId, ...pickedSources(charts, tileId)]) {
    const d = charts[home]?.drawings?.find((x) => x.id === id);
    if (d && (home === tileId || d.instrument === charts[tileId]?.instrument)) return home;
  }
  return null;
}

function sameItems(a: readonly Drawing[], b: readonly Drawing[]): boolean {
  return a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
}

export function useShownDrawings(layoutId: string, tileId: string): readonly Drawing[] {
  const select = useMemo(() => {
    let last: readonly Drawing[] = NO_DRAWINGS;
    return (s: LayoutsState): readonly Drawing[] => {
      const charts = s.layouts[layoutId]?.charts;
      const next = charts ? shownDrawings(charts, tileId) : NO_DRAWINGS;
      if (!sameItems(last, next)) last = next;
      return last;
    };
  }, [layoutId, tileId]);
  return useLayouts(select);
}

export interface SourceChoice {
  tileId: string;
  label: string;
  picked: boolean;
}

export function chartLabel(chart: ChartState): string {
  const interval = chart.printBars ? printBarsShort(chart.printBars) : chart.timeframe;
  return `${displaySymbol(chart.instrument)} ${interval}`;
}

export function sourceChoices(charts: Charts, tileId: string): SourceChoice[] {
  const chart = charts[tileId];
  if (!chart) return [];
  const picked = new Set(pickedSources(charts, tileId));
  return Object.values(charts)
    .filter((c) => c.tileId !== tileId && (c.instrument === chart.instrument || picked.has(c.tileId)))
    .map((c) => ({ tileId: c.tileId, label: chartLabel(c), picked: picked.has(c.tileId) }));
}

export function sharedLabels(choices: readonly SourceChoice[], own: string): ReadonlySet<string> {
  const counts = new Map<string, number>([[own, 1]]);
  for (const c of choices) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([label]) => label));
}
