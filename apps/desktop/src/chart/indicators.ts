import type { IndicatorStyle, InputValue } from '@tessera/chart';
import {
  COLOR_SWATCHES,
  INDICATOR_SPECS,
  type ChartLayer,
  type FillStyle,
  type IndicatorInput,
  type IndicatorLabels,
  type IndicatorSpec,
  type PlotStyle,
} from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { currentResolvedTheme, swatchesFor, swatchesOf } from './chartTheme.ts';
import { CUSTOM_KIND, customLayerSpec, type CustomCatalog } from '../indicators/custom.ts';
import { isTimeZone } from '../state/timeZone.ts';

const BY_KIND = new Map<string, IndicatorSpec>(INDICATOR_SPECS.map((s) => [s.kind, s]));

export function indicatorSpec(kind: string): IndicatorSpec | null {
  return BY_KIND.get(kind) ?? null;
}

export function layerSpec(layer: ChartLayer, custom?: CustomCatalog): IndicatorSpec | null {
  return layer.kind === CUSTOM_KIND ? customLayerSpec(layer, custom) : indicatorSpec(layer.kind);
}

export function drawnAsIndicator(spec: IndicatorSpec): boolean {
  return spec.group !== 'order_flow';
}

export function isIndicatorKind(kind: string): boolean {
  return kind === CUSTOM_KIND || indicatorSpec(kind) !== null;
}

function refOf(params: unknown): Obj {
  const p = obj(params);
  return {
    ...('indicator' in p ? { indicator: p.indicator } : {}),
    ...('version' in p && p.version !== null ? { version: p.version } : {}),
  };
}

export interface IndicatorSettings {
  inputs: Record<string, InputValue>;
  plots: Record<string, PlotStyle>;
  fills: Record<string, FillStyle>;
  labels: IndicatorLabels | null;
  height: number | null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

const BIG_TRADES_TIER_INPUTS = ['mode', 'high', 'medium', 'low'] as const;
const BIG_TRADES_TIERS = ['low', 'medium', 'high'] as const;

function bigTradesBySize(p: Obj): Obj {
  const inputs = p.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return p;
  const given = inputs as Obj;
  if ('size' in given) return p;
  const tiered = BIG_TRADES_TIER_INPUTS.some((k) => k in given);
  const min = typeof given.minSize === 'number' ? given.minSize : null;
  if (!tiered && min === null) return p;
  const positive = min !== null && min > 0;
  const fixed = tiered ? given.mode === 'manual' : positive;
  const tier = BIG_TRADES_TIERS.find((k) => given[k] !== false) ?? 'low';
  const kept = Object.fromEntries(
    Object.entries(given).filter(
      ([k]) =>
        !(BIG_TRADES_TIER_INPUTS as readonly string[]).includes(k) && !(k === 'minSize' && min !== null && !positive),
    ),
  );
  return { ...p, inputs: { ...kept, size: fixed ? 'fixed' : 'auto', ...(fixed ? {} : { tier }) } };
}

export function migrateLegacy(kind: string, params: unknown): Obj {
  const p = obj(params);
  if (kind === 'big_trades') return bigTradesBySize(p);
  if ('inputs' in p || 'style' in p) return p;
  if ((kind === 'sma' || kind === 'ema') && 'period' in p) {
    const { period, ...rest } = p;
    return { ...rest, inputs: { length: period } };
  }
  if (kind === 'vwap' && 'bands' in p) {
    const { bands, ...rest } = p;
    const inputs: Obj = {};
    legacyVwapMults(bands).forEach((k, n) => {
      inputs[`mult${String(n + 1)}`] = k;
    });
    return { ...rest, inputs };
  }
  if (kind === 'volume' && 'mode' in p) {
    const { mode: _mode, ...rest } = p;
    return rest;
  }
  return p;
}

function legacyVwapMults(bands: unknown): number[] {
  const mult = INDICATOR_SPECS.find((s) => s.kind === 'vwap')?.inputs.find((i) => i.key === 'mult1');
  const lo = mult?.min ?? 0.1;
  const hi = mult?.max ?? 5;
  const ks = Array.isArray(bands) ? bands.filter((k): k is number => typeof k === 'number' && Number.isFinite(k)) : [];
  return ks
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((k) => Math.min(hi, Math.max(lo, k)));
}

function isColor(c: unknown): c is string {
  return typeof c === 'string' && (COLOR_SWATCHES.includes(c) || /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c));
}

const SESSION_HOURS = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/;

export function isSessionHours(v: unknown): v is string {
  const m = typeof v === 'string' ? SESSION_HOURS.exec(v) : null;
  if (!m) return false;
  const [, h1, m1, h2, m2] = m.map(Number) as [number, number, number, number, number];
  return h1 * 60 + m1 < 1440 && h2 * 60 + m2 <= 1440 && m1 <= 59 && m2 <= 59;
}

function inputValue(input: IndicatorInput, v: unknown): InputValue {
  const lo = input.min ?? -Infinity;
  const hi = input.max ?? Infinity;
  switch (input.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : input.default;
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : input.default;
    case 'bool':
      return typeof v === 'boolean' ? v : input.default;
    case 'source':
      return typeof v === 'string' && ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'].includes(v)
        ? v
        : input.default;
    case 'enum':
      return typeof v === 'string' && (input.options ?? []).some((o) => o.value === v) ? v : input.default;
    case 'color':
      return isColor(v) ? v : input.default;
    case 'session':
      return isSessionHours(v) ? v : input.default;
    case 'timezone':
      return isTimeZone(v) ? v : input.default;
    case 'time':
      return typeof v === 'string' && (v === '' || Number.isFinite(Date.parse(v))) ? v : input.default;
  }
}

function between(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function plotStyle(base: PlotStyle, given: unknown): PlotStyle {
  const g = obj(given);
  return {
    color: isColor(g.color) ? g.color : base.color,
    downColor: isColor(g.downColor) ? g.downColor : base.downColor,
    width: between(g.width, 0.5, 4) ? g.width : base.width,
    line: g.line === 'solid' || g.line === 'dash' || g.line === 'dot' ? g.line : base.line,
    opacity: between(g.opacity, 0, 1) ? g.opacity : base.opacity,
    visible: typeof g.visible === 'boolean' ? g.visible : base.visible,
  };
}

function fillStyle(base: FillStyle, given: unknown): FillStyle {
  const g = obj(given);
  return {
    color: isColor(g.color) ? g.color : base.color,
    opacity: between(g.opacity, 0, 1) ? g.opacity : base.opacity,
    visible: typeof g.visible === 'boolean' ? g.visible : base.visible,
  };
}

function hasLabels(spec: IndicatorSpec): boolean {
  return spec.plots.some((p) => p.kind === 'line');
}

function defaultLabels(spec: IndicatorSpec): IndicatorLabels {
  return { priceScale: spec.placement === 'pane', name: false, value: false };
}

function labelsOf(spec: IndicatorSpec, given: unknown): IndicatorLabels | null {
  if (!hasLabels(spec)) return null;
  const d = defaultLabels(spec);
  const g = obj(given);
  const flag = (k: keyof IndicatorLabels) => (typeof g[k] === 'boolean' ? g[k] : d[k]);
  return { priceScale: flag('priceScale'), name: flag('name'), value: flag('value') };
}

export function resolveIndicator(spec: IndicatorSpec, params: unknown): IndicatorSettings {
  const p = migrateLegacy(spec.kind, params);
  const given = obj(p.inputs);
  const style = obj(p.style);
  const plots = obj(style.plots);
  const fills = obj(style.fills);
  return {
    inputs: Object.fromEntries(spec.inputs.map((i) => [i.key, inputValue(i, given[i.key])])),
    plots: Object.fromEntries(spec.plots.map((x) => [x.key, plotStyle(x.default, plots[x.key])])),
    fills: Object.fromEntries(spec.fills.map((x) => [x.key, fillStyle(x.default, fills[x.key])])),
    labels: labelsOf(spec, style.labels),
    height: spec.height === null ? null : between(p.height, 0.05, 0.8) ? p.height : spec.height,
  };
}

export function indicatorParams(settings: IndicatorSettings): ChartLayer['params'] {
  return {
    inputs: settings.inputs,
    style: {
      plots: settings.plots,
      fills: settings.fills,
      ...(settings.labels === null ? {} : { labels: settings.labels }),
    },
    ...(settings.height === null ? {} : { height: settings.height }),
  };
}

export function indicatorLabel(spec: IndicatorSpec, inputs: Readonly<Record<string, InputValue>>): string {
  const summary = indicatorSummary(spec, inputs);
  const name = indicatorName(spec, inputs);
  return summary ? `${name} ${summary}` : name;
}

export function indicatorName(spec: IndicatorSpec, inputs: Readonly<Record<string, InputValue>>): string {
  if (spec.kind === 'delta') return inputs.mode === 'bar' ? 'Δ' : 'CVD';
  if (
    (spec.kind === 'volume_profile' || spec.kind === 'market_profile') &&
    inputs.period &&
    inputs.period !== 'session'
  )
    return `${spec.short} ${String(inputs.period)}`;
  return spec.short;
}

const NAMED_BY: Readonly<Record<string, string>> = { delta: 'mode', market_profile: 'period' };

const SUMMARY_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'volume_profile.show': { volumeDelta: 'volume+delta' },
  'volume_profile.hours': { all: 'ETH', rth: 'RTH', split: 'RTH/ETH' },
  'market_profile.tpo': { '5': '5m', '10': '10m', '15': '15m', '30': '30m', '60': '60m' },
  'market_profile.hours': { all: 'ETH', rth: 'RTH' },
  'big_trades.price': { start: 'first print', last: 'last print' },
  'opening_range.open': { session: 'from session open' },
  'opening_range.extensions': { range: 'OR extensions' },
  'footprint.maxLevel': { volume: 'max volume', trades: 'max trades', bid: 'max bid', ask: 'max ask' },
};

function summaryValue(spec: IndicatorSpec, key: string, v: InputValue): string {
  if (key === 'ratio' && (spec.kind === 'footprint' || spec.kind === 'stacked_imbalance')) return `${String(v)}:1`;
  if (spec.kind === 'stacked_imbalance' && key === 'stackRows') return `×${String(v)}`;
  return SUMMARY_WORDS[`${spec.kind}.${key}`]?.[String(v)] ?? String(v);
}

export function indicatorSummary(spec: IndicatorSpec, inputs: Readonly<Record<string, InputValue>>): string {
  const parts: string[] = [];
  spec.inputs.forEach((i) => {
    if (NAMED_BY[spec.kind] === i.key) return;
    if (i.when || spec.inputs.some((u) => u.when?.input === i.key)) return;
    const v = inputs[i.key] ?? i.default;
    if (i.inLabel || ((i.type === 'source' || i.type === 'enum') && v !== i.default))
      parts.push(summaryValue(spec, i.key, v));
  });
  return parts.join(' ');
}

export type SwatchPalette = Readonly<Record<string, string>>;

export function themeSwatches(kind?: string): SwatchPalette {
  const r = currentResolvedTheme();
  return kind ? swatchesFor(r, kind) : swatchesOf(r);
}

export function colorOf(c: string | null | undefined, palette: SwatchPalette = themeSwatches()): string {
  if (!c) return palette.t2 ?? TOKENS.t2;
  if (c.startsWith('#')) return c;
  return palette[c] ?? palette.t2 ?? TOKENS.t2;
}

export function analystPlot(spec: IndicatorSpec, settings: IndicatorSettings, agent: boolean): string | null {
  if (!agent) return null;
  const first = spec.plots.find((p) => p.kind === 'line');
  if (!first) return null;
  return (settings.plots[first.key] ?? first.default).color === first.default.color ? first.key : null;
}

export function engineStyle(
  spec: IndicatorSpec,
  settings: IndicatorSettings,
  options: { agent?: boolean; palette?: SwatchPalette } = {},
): IndicatorStyle {
  const palette = options.palette ?? themeSwatches(spec.kind);
  const aqua = analystPlot(spec, settings, options.agent === true);
  const plots: IndicatorStyle['plots'] = Object.fromEntries(
    spec.plots.map((x) => {
      const s = settings.plots[x.key] ?? x.default;
      const color = x.key === aqua ? (palette.aqua ?? TOKENS.aqua) : colorOf(s.color, palette);
      return [
        x.key,
        {
          color,
          downColor: s.downColor ? colorOf(s.downColor, palette) : null,
          width: s.width,
          line: s.line,
          opacity: s.opacity,
          visible: s.visible,
        },
      ];
    }),
  );
  const fills: IndicatorStyle['fills'] = Object.fromEntries(
    spec.fills.map((x) => {
      const s = settings.fills[x.key] ?? x.default;
      return [x.key, { color: colorOf(s.color, palette), opacity: s.opacity, visible: s.visible }];
    }),
  );
  return { plots, fills, ...(settings.labels === null ? {} : { labels: settings.labels }) };
}

function freeId(layers: readonly ChartLayer[], kind: string): string {
  let n = 1;
  while (layers.some((l) => l.id === `${kind}-${String(n)}`)) n++;
  return `${kind}-${String(n)}`;
}

export function addIndicator(
  layers: readonly ChartLayer[],
  kind: string,
  params: Readonly<Record<string, unknown>> | null = null,
): { layers: ChartLayer[]; id: string } {
  const id = freeId(layers, kind);
  const layer: ChartLayer = {
    id,
    kind,
    params: (params ? { ...params } : {}) as ChartLayer['params'],
    visible: true,
    namespace: 'user',
    sessionId: null,
  };
  return { layers: [...layers, layer], id };
}

export function removeLayer(layers: readonly ChartLayer[], id: string): ChartLayer[] {
  return layers.filter((l) => l.id !== id);
}

export function showLayer(layers: readonly ChartLayer[], id: string, visible: boolean): ChartLayer[] {
  return layers.map((l) => (l.id === id && l.visible !== visible ? { ...l, visible } : l));
}

export function withSettings(layers: readonly ChartLayer[], id: string, settings: IndicatorSettings): ChartLayer[] {
  return layers.map((l) =>
    l.id === id
      ? { ...l, params: { ...refOf(l.params), ...obj(indicatorParams(settings)) } as ChartLayer['params'] }
      : l,
  );
}

export function addCustomIndicator(
  layers: readonly ChartLayer[],
  indicator: string,
  params: Readonly<Record<string, unknown>> | null = null,
): { layers: ChartLayer[]; id: string } {
  const id = freeId(layers, CUSTOM_KIND);
  const layer: ChartLayer = {
    id,
    kind: CUSTOM_KIND,
    params: { ...(params ?? {}), indicator },
    visible: true,
    namespace: 'user',
    sessionId: null,
  };
  return { layers: [...layers, layer], id };
}

export function defaultSettings(spec: IndicatorSpec, current?: IndicatorSettings): IndicatorSettings {
  const d = resolveIndicator(spec, {});
  return current ? { ...d, height: current.height } : d;
}

export function isDefault(spec: IndicatorSpec, settings: IndicatorSettings): boolean {
  const d = defaultSettings(spec, settings);
  return JSON.stringify(indicatorParams(d)) === JSON.stringify(indicatorParams(settings));
}

export function layerOfPane(paneId: string): string | null {
  return paneId.startsWith('pane:model:') ? paneId.slice('pane:model:'.length) : null;
}

export function withPaneHeights(
  layers: readonly ChartLayer[],
  heights: readonly { id: string; height: number }[],
): ChartLayer[] | null {
  const next = layers.map((l) => {
    const h = heights.find((x) => layerOfPane(x.id) === l.id)?.height;
    const spec = layerSpec(l);
    if (h === undefined || spec?.placement !== 'pane') return l;
    const settings = resolveIndicator(spec, l.params);
    const height = Math.round(Math.min(0.8, Math.max(0.05, h)) * 1000) / 1000;
    return settings.height === height
      ? l
      : {
          ...l,
          params: { ...refOf(l.params), ...obj(indicatorParams({ ...settings, height })) } as ChartLayer['params'],
        };
  });
  return next.some((l, k) => l !== layers[k]) ? next : null;
}
