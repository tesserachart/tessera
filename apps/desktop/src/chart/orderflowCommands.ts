import type { ChartLayer } from '@tessera/protocol';
import type { Command } from '../commands/registry.ts';
import { activeChartTarget, updateChart } from '../workspace/controller.ts';
import { addIndicator, showLayer } from './indicators.ts';
import { startParams } from './presets/model.ts';
import { presetsStore } from './presets/store.ts';
import { read } from '../app/store.ts';
import type { ChartRef } from './settings/store.ts';

export function toggleKind(layers: readonly ChartLayer[], kind: string): ChartLayer[] {
  const held = layers.find((l) => l.kind === kind);
  if (!held) return addIndicator(layers, kind, startParams(read(presetsStore), kind)).layers;
  return showLayer(layers, held.id, !held.visible);
}

export interface OrderFlowView {
  kind: string;
  name: string;
  shortcut?: string;
  keywords: string[];
}

const VIEWS: readonly OrderFlowView[] = [
  { kind: 'footprint', name: 'Footprint', shortcut: 'alt+shift+f', keywords: ['bid ask', 'cells', 'order flow'] },
  { kind: 'volume_profile', name: 'Volume profile', shortcut: 'alt+p', keywords: ['vp', 'poc', 'value area'] },
  { kind: 'delta', name: 'Delta pane', shortcut: 'alt+d', keywords: ['cvd', 'cumulative delta'] },
  { kind: 'big_trades', name: 'Big trades', shortcut: 'alt+b', keywords: ['bubbles', 'large prints'] },
  {
    kind: 'stacked_imbalance',
    name: 'Stacked imbalance',
    keywords: ['imbalance zones', 'imbalance tracker', 'stacks'],
  },
  { kind: 'market_profile', name: 'Market profile', keywords: ['tpo', 'letters', 'time price opportunity'] },
];

export const CHART_TYPE_VIEWS: readonly OrderFlowView[] = VIEWS.filter(
  (v) => v.kind === 'footprint' || v.kind === 'volume_profile',
);

export function toggleChartView(chart: ChartRef, kind: string): Promise<void> {
  return updateChart(chart.layoutId, chart.tileId, (c) => ({ ...c, layers: toggleKind(c.layers, kind) }));
}

export function kindShown(layers: readonly ChartLayer[], kind: string): boolean {
  return layers.some((l) => l.kind === kind && l.visible);
}

export function orderFlowCommands(): Command[] {
  return VIEWS.map((v) => ({
    id: `chart.orderflow.${v.kind}`,
    title: `${v.name}: show or hide`,
    group: 'Chart',
    keywords: ['order flow', ...v.keywords],
    ...(v.shortcut ? { shortcut: v.shortcut } : {}),
    zone: 'chart',
    when: () => activeChartTarget() !== null,
    run: () => {
      const target = activeChartTarget();
      if (target) void toggleChartView(target, v.kind);
    },
  }));
}
