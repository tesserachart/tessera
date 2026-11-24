import type { IndicatorPreset } from '@tessera/protocol';
import { layoutSaved } from '../../workspace/controller.ts';
import type { ChartRef } from '../settings/store.ts';
import { putPresets, presetsStore } from './store.ts';
import { read } from '../../app/store.ts';
import { runTool } from '../../app/tools.ts';
import { answerFor } from '../../state/runtimeSettings.ts';

function target(chart: ChartRef): ChartRef {
  return { layoutId: chart.layoutId, tileId: chart.tileId };
}

export async function savePreset(chart: ChartRef, layerId: string, name: string): Promise<IndicatorPreset> {
  await layoutSaved();
  const out = await runTool('chart.save_indicator_preset', { ...target(chart), layerId, name });
  const s = read(presetsStore);
  const presets = s.presets.some((p) => p.id === out.preset.id)
    ? s.presets.map((p) => (p.id === out.preset.id ? out.preset : p))
    : [...s.presets, out.preset];
  putPresets({ presets, defaults: s.defaults });
  return out.preset;
}

export async function saveDefault(chart: ChartRef, layerId: string): Promise<void> {
  await layoutSaved();
  const fresh = answerFor('chart.indicatorPresets');
  const out = await runTool('chart.set_indicator_default', { ...target(chart), layerId });
  if (fresh()) putPresets(out);
}

export async function clearDefault(indicator: string): Promise<void> {
  const fresh = answerFor('chart.indicatorPresets');
  const out = await runTool('chart.set_indicator_default', { indicator, clear: true });
  if (fresh()) putPresets(out);
}

export async function renamePreset(id: string, name: string): Promise<void> {
  const fresh = answerFor('chart.indicatorPresets');
  const out = await runTool('chart.edit_indicator_preset', { preset: id, name });
  if (fresh()) putPresets(out);
}

export async function deletePreset(id: string): Promise<void> {
  const fresh = answerFor('chart.indicatorPresets');
  const out = await runTool('chart.delete_indicator_preset', { preset: id });
  if (fresh()) putPresets(out);
}
