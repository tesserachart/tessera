import type { LayerKindsOutput, LayerRequirement } from '@tessera/protocol';
import { useEffect, useState } from 'react';
import { useInRuntime } from '../../app/connection.ts';
import type { ChartRef } from './store.ts';
import { runTool } from '../../app/tools.ts';

export interface Unavailable {
  requires: LayerRequirement | null;
  reason: string;
}

export function requirementWords(req: LayerRequirement | null): string {
  if (req === 'footprint') return 'Needs trades with aggressor';
  return 'Not available here';
}

export function unavailableKinds(out: LayerKindsOutput): Map<string, Unavailable> {
  const m = new Map<string, Unavailable>();
  for (const k of out.kinds) {
    if (k.available || !k.drawn) continue;
    m.set(k.kind, { requires: k.requires, reason: k.reason ?? '' });
  }
  return m;
}

export function useUnavailableKinds(chart: ChartRef, open: boolean): ReadonlyMap<string, Unavailable> {
  const inRuntime = useInRuntime();
  const [kinds, setKinds] = useState<ReadonlyMap<string, Unavailable>>(new Map());
  useEffect(() => {
    if (!open || !inRuntime) return;
    let live = true;
    runTool('chart.list_layer_kinds', { layoutId: chart.layoutId, tileId: chart.tileId })
      .then((out) => {
        if (live) setKinds(unavailableKinds(out));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, inRuntime, chart.layoutId, chart.tileId]);
  return kinds;
}
