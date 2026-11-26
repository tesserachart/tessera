import type { ChartTemplate, CustomIndicator } from '@tessera/protocol';
import { read } from '../app/store.ts';
import { CUSTOM_KIND } from '../indicators/custom.ts';
import { layoutsStore } from '../state/layouts.ts';
import { shareSetup, type ChartTarget } from './store.ts';

function hasCustom(layers: readonly { kind: string }[]): boolean {
  return layers.some((l) => l.kind === CUSTOM_KIND);
}

export function shareIndicator(chart: ChartTarget, layer: { id: string; kind: string }, name: string): Promise<void> {
  return shareSetup(
    { kind: 'indicator', layoutId: chart.layoutId, tileId: chart.tileId, layerId: layer.id },
    name,
    layer.kind === CUSTOM_KIND,
  );
}

export function shareCustomIndicator(indicator: CustomIndicator): Promise<void> {
  return shareSetup({ kind: 'custom_indicator', id: indicator.id }, indicator.spec.title, true);
}

export function shareTemplate(template: ChartTemplate): Promise<void> {
  return shareSetup({ kind: 'template', id: template.id }, template.name, hasCustom(template.layers));
}

export function shareWorkspace(layoutId: string, name: string): Promise<void> {
  const charts = Object.values(read(layoutsStore).layouts[layoutId]?.charts ?? {});
  return shareSetup(
    { kind: 'layout', layoutId },
    name,
    charts.some((c) => hasCustom(c.layers)),
  );
}
