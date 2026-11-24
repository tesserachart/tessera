import { INDICATOR_SPECS, type ChartLayer, type InputOption } from '@tessera/protocol';
import { makeStore, patch, read, useStore } from '../app/store.ts';
import { updateChart } from '../workspace/controller.ts';
import type { ChartRef } from './settings/store.ts';

export interface ProfileQuick {
  show: string;
  valueArea: number;
  rowTicks: string;
}

export interface PlacedProfileRef extends ChartRef {
  layerId: string;
}

const SPEC = INDICATOR_SPECS.find((s) => s.kind === 'volume_profile')!;
const optionsOf = (key: string): readonly InputOption[] => SPEC.inputs.find((i) => i.key === key)?.options ?? [];

const SHOW_WORDS: Readonly<Record<string, string>> = {
  volume: 'Volume',
  split: 'Buy/Sell',
  delta: 'Delta',
  volumeDelta: 'Vol+Δ',
};

export const PROFILE_SHOWS: readonly { value: string; label: string }[] = optionsOf('show').map((o) => ({
  value: o.value,
  label: SHOW_WORDS[o.value] ?? o.label,
}));
export const PROFILE_ROW_SIZES: readonly InputOption[] = optionsOf('rowTicks');
export const PROFILE_VALUE_AREAS: readonly number[] = [50, 60, 65, 68, 70, 75, 80, 85, 90, 95];

function inputsOf(layer: ChartLayer): Record<string, unknown> {
  const params = layer.params as { inputs?: Record<string, unknown> } | null;
  return params?.inputs ?? {};
}

export function isPlacedProfile(layer: ChartLayer | undefined): layer is ChartLayer {
  if (layer?.kind !== 'volume_profile' || !layer.visible) return false;
  const period = inputsOf(layer).period;
  return period === 'range' || period === 'anchored';
}

export function profileQuick(layer: ChartLayer): ProfileQuick {
  const i = inputsOf(layer);
  return {
    show: typeof i.show === 'string' ? i.show : 'volume',
    valueArea: typeof i.valueArea === 'number' ? i.valueArea : 70,
    rowTicks: typeof i.rowTicks === 'string' ? i.rowTicks : 'auto',
  };
}

export function withProfileInputs(
  layers: readonly ChartLayer[],
  layerId: string,
  change: Partial<ProfileQuick>,
): ChartLayer[] {
  return layers.map((l) =>
    l.id === layerId ? { ...l, params: { ...(l.params as object), inputs: { ...inputsOf(l), ...change } } } : l,
  );
}

export function setProfileInputs(ref: PlacedProfileRef, change: Partial<ProfileQuick>): void {
  void updateChart(ref.layoutId, ref.tileId, (c) => ({
    ...c,
    layers: withProfileInputs(c.layers, ref.layerId, change),
  }));
}

export function removeProfile(ref: PlacedProfileRef): void {
  selectProfile(null);
  void updateChart(ref.layoutId, ref.tileId, (c) => ({ ...c, layers: c.layers.filter((l) => l.id !== ref.layerId) }));
}

const selection = makeStore<{ selected: PlacedProfileRef | null }>({ selected: null });

export function selectProfile(selected: PlacedProfileRef | null): void {
  const was = read(selection).selected;
  if (was?.layerId === selected?.layerId && was?.tileId === selected?.tileId && was?.layoutId === selected?.layoutId)
    return;
  patch(selection, { selected });
}

export function useSelectedProfile(chart: ChartRef): string | null {
  return useStore(selection, (s) =>
    s.selected?.layoutId === chart.layoutId && s.selected.tileId === chart.tileId ? s.selected.layerId : null,
  );
}
