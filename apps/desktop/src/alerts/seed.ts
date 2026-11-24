import { footprintRowTicks, stackRowTicks } from '@tessera/chart';
import type { ChartLayer, Drawing, FlowSide, JsonValue, Level } from '@tessera/protocol';
import { layerSpec, resolveIndicator } from '../chart/indicators.ts';
import { drawnLineLabels } from '../chart/layers/custom.ts';
import { indicatorName } from '../chart/settings/model.ts';
import { indicatorOf } from '../chart/presets/model.ts';
import { rowTicksOf } from '../chart/layers/orderflow/common.ts';
import { operandChoice, type OperandChoice } from './form.ts';

export const COMPUTED_BUILTINS: ReadonlySet<string> = new Set([
  'sma',
  'ema',
  'wma',
  'vwap',
  'volume',
  'rsi',
  'atr',
  'bollinger',
  'macd',
  'stochastic',
  'delta',
  'opening_range',
]);

const LINES = new Set([
  'horizontal_line',
  'horizontal_ray',
  'cross_line',
  'trend_line',
  'trend_angle',
  'ray',
  'extended_line',
]);

const DRAWING_WORD: Record<string, string> = {
  horizontal_line: 'Horizontal line',
  horizontal_ray: 'Horizontal ray',
  cross_line: 'Cross line',
  trend_line: 'Trend line',
  trend_angle: 'Trend angle',
  ray: 'Ray',
  extended_line: 'Extended line',
};

export function levelChoice(l: Pick<Level, 'key' | 'label'>): OperandChoice {
  return operandChoice({ kind: 'level', key: l.key, label: l.label }, l.label);
}

export function drawingChoice(d: Pick<Drawing, 'id' | 'kind' | 'label'>): OperandChoice | null {
  if (!LINES.has(d.kind)) return null;
  const text = d.label?.text.trim() ?? '';
  const words = text === '' ? (DRAWING_WORD[d.kind] ?? 'Line') : text;
  return operandChoice({ kind: 'drawing', drawingId: d.id, label: words }, words);
}

function inputsOf(layer: ChartLayer): Record<string, JsonValue> {
  const spec = layerSpec(layer);
  if (!spec) return {};
  return resolveIndicator(spec, layer.params).inputs;
}

export function plotChoices(layer: ChartLayer): OperandChoice[] {
  const spec = layerSpec(layer);
  const indicator = indicatorOf(layer);
  if (!spec || !indicator || (!indicator.startsWith('ci_') && !COMPUTED_BUILTINS.has(indicator))) return [];
  const name = indicatorName(layer) ?? spec.short;
  const lines = spec.plots.filter((p) => p.kind === 'line');
  const inputs = inputsOf(layer);
  return lines.map((p) => {
    const label = lines.length > 1 ? `${name} · ${p.label}` : name;
    return operandChoice({ kind: 'plot', indicator, inputs, plot: p.key, label }, label);
  });
}

export function lineChoices(layer: ChartLayer, labels: readonly string[]): OperandChoice[] {
  const indicator = indicatorOf(layer);
  const spec = layerSpec(layer);
  if (!indicator?.startsWith('ci_') || !spec) return [];
  const inputs = inputsOf(layer);
  return labels.map((label) => {
    return operandChoice(
      { kind: 'indicator_line', indicator, inputs, label, name: spec.short },
      `${label} · ${spec.short}`,
    );
  });
}

const STACK_SIDES: readonly FlowSide[] = ['either', 'ask', 'bid'];

export function stackChoices(layer: ChartLayer, root: string | null | undefined): OperandChoice[] {
  if (layer.kind !== 'stacked_imbalance') return [];
  const i = inputsOf(layer);
  const rowTicks = stackRowTicks({ rowTicks: rowTicksOf(i.rowTicks), minRowTicks: footprintRowTicks(root) });
  return STACK_SIDES.map((side) =>
    operandChoice({
      kind: 'stacked_imbalance',
      side,
      ratio: Number(i.ratio),
      minVolume: Number(i.minVolume),
      minDifference: Number(i.minDifference),
      includeZero: i.includeZero === true,
      rowTicks,
    }),
  );
}

export function stackOf(layer: ChartLayer): number | undefined {
  if (layer.kind !== 'stacked_imbalance') return undefined;
  const rows = Number(inputsOf(layer).stackRows);
  return Number.isInteger(rows) ? rows : undefined;
}

export function chartPlotChoices(layers: readonly ChartLayer[], root?: string | null): OperandChoice[] {
  const shown = layers.filter((l) => l.visible);
  return [
    ...shown.flatMap((l) => lineChoices(l, drawnLineLabels(l.id))),
    ...shown.flatMap(plotChoices),
    ...shown.flatMap((l) => stackChoices(l, root)),
  ];
}
