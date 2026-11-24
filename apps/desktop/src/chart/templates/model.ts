import type { ChartLayer, ChartTemplate, ChartTemplates, ChartType, TemplateLayer } from '@tessera/protocol';
import { CHART_TYPE_WORD, SERIES_TYPES, type ChartSetup } from '../../state/layouts.ts';
import { stableStringify } from '../../workspace/layouts.ts';
import { indicatorParams, isIndicatorKind, layerSpec, resolveIndicator } from '../indicators.ts';
import { indicatorName } from '../settings/model.ts';
import { isOrderFlow, ORDER_FLOW_KINDS, ORDER_FLOW_TEMPLATE } from './orderFlow.ts';

export const NAME_MAX = 48;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function readLayer(v: unknown): TemplateLayer | null {
  const o = obj(v);
  if (!o || typeof o.kind !== 'string' || !isIndicatorKind(o.kind)) return null;
  return {
    kind: o.kind,
    params: (obj(o.params) ?? {}) as TemplateLayer['params'],
    visible: typeof o.visible === 'boolean' ? o.visible : true,
  };
}

export function readTemplates(value: unknown): ChartTemplates {
  const o = obj(value);
  const templates: ChartTemplate[] = [];
  for (const raw of Array.isArray(o?.templates) ? o.templates : []) {
    const t = obj(raw);
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    if (!t || typeof t.id !== 'string' || t.id === '' || name === '') continue;
    if (templates.some((x) => x.id === t.id)) continue;
    const layers = (Array.isArray(t.layers) ? t.layers : []).map(readLayer).filter((l) => l !== null);
    templates.push({
      id: t.id,
      name,
      layers,
      ...(SERIES_TYPES.includes(t.chartType as ChartType) ? { chartType: t.chartType as ChartType } : {}),
    });
  }
  const id = o?.defaultId;
  return typeof id === 'string' && templates.some((t) => t.id === id) ? { templates, defaultId: id } : { templates };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function templateNamed(all: ChartTemplates, name: string): ChartTemplate | null {
  return all.templates.find((t) => sameName(t.name, name)) ?? null;
}

export function defaultTemplate(all: ChartTemplates): ChartTemplate | null {
  return all.templates.find((t) => t.id === all.defaultId) ?? null;
}

export function newChartSetup(all: ChartTemplates, loaded: boolean): ChartSetup | null {
  if (!loaded) return null;
  return defaultTemplate(all);
}

export function renameProblem(all: ChartTemplates, id: string, name: string): string | null {
  const n = name.trim();
  if (n === '') return 'A template needs a name';
  if (n.length > NAME_MAX) return `At most ${String(NAME_MAX)} characters`;
  if (all.templates.some((t) => t.id !== id && sameName(t.name, n))) return `${n} is taken`;
  return null;
}

function asLayer(kind: string, params: unknown): ChartLayer {
  return { id: '', kind, params: params as ChartLayer['params'], visible: true, namespace: 'user', sessionId: null };
}

function paramsKey(kind: string, params: unknown): string {
  const layer = asLayer(kind, params);
  const spec = layerSpec(layer);
  const ref = kind === 'custom' && params && typeof params === 'object' ? (params as Obj).indicator : undefined;
  return stableStringify(spec ? { ref, ...(indicatorParams(resolveIndicator(spec, params)) as Obj) } : params);
}

export function chartMatches(layers: readonly ChartLayer[], chartType: ChartType, template: ChartTemplate): boolean {
  if (template.chartType && template.chartType !== chartType) return false;
  const mine = layers.filter((l) => isIndicatorKind(l.kind));
  if (mine.length !== template.layers.length) return false;
  return mine.every((l, i) => {
    const t = template.layers[i]!;
    return l.kind === t.kind && l.visible === t.visible && paramsKey(l.kind, l.params) === paramsKey(t.kind, t.params);
  });
}

export const ORDER_FLOW: ChartTemplate = {
  id: ORDER_FLOW_TEMPLATE,
  name: ORDER_FLOW_TEMPLATE,
  layers: ORDER_FLOW_KINDS.map((kind) => ({ kind, params: {}, visible: true })),
};

export function isBuiltin(t: ChartTemplate): boolean {
  return t.id === ORDER_FLOW.id;
}

export function templateSummary(t: ChartTemplate): string {
  const names = t.layers.map((l) => indicatorName(asLayer(l.kind, l.params)) ?? l.kind);
  const parts = [...(t.chartType ? [CHART_TYPE_WORD[t.chartType]] : []), ...names];
  return parts.length > 0 ? parts.join(' · ') : 'No indicators';
}

export interface ChartTemplateNow {
  template: ChartTemplate;
  modified: boolean;
}

function shows(layers: readonly ChartLayer[], chartType: ChartType, t: ChartTemplate): boolean {
  return isBuiltin(t) ? isOrderFlow(layers) : chartMatches(layers, chartType, t);
}

export function chartTemplateNow(
  templates: readonly ChartTemplate[],
  layers: readonly ChartLayer[],
  chartType: ChartType,
  followedId: string | null,
): ChartTemplateNow | null {
  const all = [...templates, ORDER_FLOW];
  const followed = all.find((t) => t.id === followedId) ?? null;
  if (followed && shows(layers, chartType, followed)) return { template: followed, modified: false };
  const match = all.find((t) => shows(layers, chartType, t));
  if (match) return { template: match, modified: false };
  return followed ? { template: followed, modified: true } : null;
}

export function chipWords(now: ChartTemplateNow | null): string {
  if (!now) return 'None';
  return now.modified ? `${now.template.name} · modified` : now.template.name;
}

export function copyName(all: ChartTemplates, name: string): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${String(n)}`;
    const candidate = `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!templateNamed(all, candidate)) return candidate;
  }
}
