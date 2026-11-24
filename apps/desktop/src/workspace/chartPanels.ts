import { read } from '../app/store.ts';
import type { ChartRef } from '../chart/settings/store.ts';
import { layoutsStore } from '../state/layouts.ts';
import { activateChart } from './controller.ts';
import { openTile } from './dock/open.ts';
import { showTitle } from './dock/library.ts';
import { tileDefinition } from './tiles/registry.ts';

const BESIDE_CHART = ['dom', 'tape', 'alerts'] as const;

export interface ChartPanel {
  kind: (typeof BESIDE_CHART)[number];
  label: string;
}

export function chartPanels(): ChartPanel[] {
  return BESIDE_CHART.flatMap((kind) => {
    const def = tileDefinition(kind);
    return def ? [{ kind, label: def.linkable ? `Open ${def.title}` : showTitle(def) }] : [];
  });
}

export function openBesideChart(kind: ChartPanel['kind'], chart: ChartRef): string | null {
  const def = tileDefinition(kind);
  if (!def) return null;
  const instrument = read(layoutsStore).layouts[chart.layoutId]?.charts[chart.tileId]?.instrument ?? null;
  activateChart(chart.layoutId, chart.tileId);
  const params = def.linkable && instrument ? { instrument, link: null } : undefined;
  return openTile(kind, { ...(params ? { params } : {}), via: 'pointer', focus: true });
}
