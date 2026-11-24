import type { ChartLayer, IndicatorPreset, IndicatorPresets, IndicatorSpec } from '@tessera/protocol';
import { CUSTOM_KIND, customRef } from '../../indicators/custom.ts';
import {
  defaultSettings,
  indicatorParams,
  isDefault,
  resolveIndicator,
  type IndicatorSettings,
} from '../indicators.ts';

export const NAME_MAX = 48;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function isIndicator(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s !== CUSTOM_KIND;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function readPresets(value: unknown): IndicatorPresets {
  const v = obj(value);
  const presets: IndicatorPreset[] = [];
  for (const raw of Array.isArray(v.presets) ? v.presets : []) {
    const p = obj(raw);
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (typeof p.id !== 'string' || !p.id || !name || !isIndicator(p.indicator)) continue;
    if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) continue;
    const indicator = p.indicator;
    if (presets.some((x) => x.id === p.id || (x.indicator === indicator && sameName(x.name, name)))) continue;
    presets.push({ id: p.id, name, indicator, params: p.params as Obj });
  }
  const defaults: Record<string, Obj> = {};
  for (const [k, d] of Object.entries(obj(v.defaults))) {
    if (isIndicator(k) && d && typeof d === 'object' && !Array.isArray(d)) defaults[k] = d as Obj;
  }
  return { presets, defaults };
}

export function indicatorOf(layer: Pick<ChartLayer, 'kind' | 'params'>): string | null {
  return layer.kind === CUSTOM_KIND ? customRef(layer.params) : layer.kind;
}

export function presetsOf(all: IndicatorPresets, indicator: string): IndicatorPreset[] {
  return all.presets.filter((p) => p.indicator === indicator);
}

export function presetNamed(all: IndicatorPresets, indicator: string, name: string): IndicatorPreset | null {
  return presetsOf(all, indicator).find((p) => sameName(p.name, name)) ?? null;
}

export function startParams(all: IndicatorPresets, indicator: string): Obj | null {
  return all.defaults[indicator] ?? null;
}

export function settingsFrom(spec: IndicatorSpec, params: unknown, current: IndicatorSettings): IndicatorSettings {
  return { ...resolveIndicator(spec, params), height: current.height };
}

export function resetSettings(
  all: IndicatorPresets,
  indicator: string,
  spec: IndicatorSpec,
  current: IndicatorSettings,
): IndicatorSettings {
  const saved = startParams(all, indicator);
  return saved ? settingsFrom(spec, saved, current) : defaultSettings(spec, current);
}

function key(spec: IndicatorSpec, settings: IndicatorSettings): string {
  const p = obj(indicatorParams({ ...settings, height: null }));
  return JSON.stringify({ inputs: p.inputs, style: p.style });
}

export function sameSettings(spec: IndicatorSpec, a: IndicatorSettings, b: IndicatorSettings): boolean {
  return key(spec, a) === key(spec, b);
}

export function matches(spec: IndicatorSpec, settings: IndicatorSettings, params: unknown): boolean {
  return key(spec, settings) === key(spec, resolveIndicator(spec, params));
}

export function currentPreset(
  all: IndicatorPresets,
  indicator: string,
  spec: IndicatorSpec,
  settings: IndicatorSettings,
): IndicatorPreset | null {
  return presetsOf(all, indicator).find((p) => matches(spec, settings, p.params)) ?? null;
}

export function renameProblem(all: IndicatorPresets, preset: IndicatorPreset, name: string): string | null {
  const n = name.trim();
  if (!n) return 'A preset needs a name';
  if (n.length > NAME_MAX) return `At most ${String(NAME_MAX)} characters`;
  const other = presetNamed(all, preset.indicator, n);
  return other && other.id !== preset.id ? `${n} is taken` : null;
}

export const DEFAULTS_LABEL = 'Defaults';

export function presetLabel(
  all: IndicatorPresets,
  indicator: string | null,
  spec: IndicatorSpec,
  settings: IndicatorSettings,
): string | null {
  if (indicator !== null) {
    const preset = presetsOf(all, indicator).find((p) => matches(spec, settings, p.params));
    if (preset) return preset.name;
    const saved = all.defaults[indicator];
    if (saved) return matches(spec, settings, saved) ? 'Default' : null;
  }
  return isDefault(spec, settings) ? DEFAULTS_LABEL : null;
}
