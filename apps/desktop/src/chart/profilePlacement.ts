import { barEnd, type DrawingPoint, type ProfilePick, type SeriesStore } from '@tessera/chart';
import { timeframeMs, type Timeframe } from '@tessera/protocol';
import { read } from '../app/store.ts';
import { updateChart } from '../workspace/controller.ts';
import { addIndicator } from './indicators.ts';
import { startParams } from './presets/model.ts';
import { presetsStore } from './presets/store.ts';
import type { ChartRef } from './settings/store.ts';

export interface PlacedInputs {
  period: 'range' | 'anchored';
  from: string;
  to: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function placedInputs(
  kind: ProfilePick,
  points: readonly DrawingPoint[],
  bars: SeriesStore | null,
  tf: Timeframe | null,
): PlacedInputs | null {
  const ts = points.map((p) => p.t).filter((t) => Number.isFinite(t));
  if (ts.length === 0) return null;
  const from = Math.min(...ts);
  if (kind === 'profile_anchored') return { period: 'anchored', from: iso(from), to: '' };
  if (ts.length < 2) return null;
  const last = Math.max(...ts);
  const step = tf ? timeframeMs(tf) : 60_000;
  const i = bars ? bars.indexAtOrBefore(last) : -1;
  const to = bars && i >= 0 ? barEnd(bars, i, step) : last + step;
  return to > from ? { period: 'range', from: iso(from), to: iso(to) } : null;
}

export function placeProfile(chart: ChartRef, inputs: PlacedInputs, placed: (layerId: string) => void): void {
  const saved = startParams(read(presetsStore), 'volume_profile');
  const savedInputs = (saved?.inputs ?? {}) as Record<string, unknown>;
  void updateChart(chart.layoutId, chart.tileId, (c) => {
    const added = addIndicator(c.layers, 'volume_profile', { ...saved, inputs: { ...savedInputs, ...inputs } });
    placed(added.id);
    return { ...c, layers: added.layers };
  });
}
