import { LEVEL_STYLES, colorChannels, type LevelKind, type LevelSpec } from '@tessera/chart';
import type { ChartLayer, Level } from '@tessera/protocol';
import { currentResolvedTheme, customLevelColor } from './chartTheme.ts';
import { withAlpha } from './levelSettings.ts';

export interface LevelsLayerParams {
  vendor?: string;
  package?: string;
  group?: string;
  fields?: string[];
}

export function levelsParams(layer: ChartLayer): LevelsLayerParams {
  const p = layer.params;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

const LAYER_OWNED = new Set(['vp']);

function layerScopes(layer: ChartLayer, level: Level): boolean {
  if (layer.kind !== 'levels') return false;
  const p = levelsParams(layer);
  if (!p.vendor && !p.group) return false;
  if (p.vendor && p.vendor !== level.source.vendor) return false;
  if (p.package && p.package !== level.source.package) return false;
  if (p.group && p.group !== level.group) return false;
  if (level.source.vendor === 'Tessera' && LAYER_OWNED.has(level.group) && p.group !== level.group) return false;
  return true;
}

export function isLevelShown(layers: readonly ChartLayer[], level: Level): boolean {
  return layers.some((l) => {
    if (!l.visible || !layerScopes(l, level)) return false;
    const fields = levelsParams(l).fields;
    return !fields || fields.includes(level.source.field);
  });
}

export function toggleLevel(layers: readonly ChartLayer[], level: Level): ChartLayer[] {
  const field = level.source.field;
  if (isLevelShown(layers, level)) {
    return layers.map((l) => {
      if (!layerScopes(l, level)) return l;
      const p = levelsParams(l);
      const fields = p.fields ?? [];
      return { ...l, params: { ...p, fields: fields.filter((f) => f !== field) } };
    });
  }
  const idx = layers.findIndex((l) => layerScopes(l, level));
  if (idx >= 0) {
    return layers.map((l, i) => {
      if (i !== idx) return l;
      const p = levelsParams(l);
      return { ...l, visible: true, params: { ...p, fields: [...(p.fields ?? []), field] } };
    });
  }
  const tessera = level.source.vendor === 'Tessera';
  const params: LevelsLayerParams = tessera
    ? { group: level.group, fields: [field] }
    : { vendor: level.source.vendor, package: level.source.package, fields: [field] };
  const id = tessera ? `levels-${level.group}` : `levels-${level.source.vendor}-${level.source.package}`.toLowerCase();
  return [
    ...layers,
    { id, kind: 'levels', params: params as ChartLayer['params'], visible: true, namespace: 'user', sessionId: null },
  ];
}

const CONCEPT_KIND: Record<string, LevelKind> = {
  gamma_flip: 'gammaFlip',
  positive_gex_extreme: 'callWall',
  negative_gex_extreme: 'putWall',
  call_wall: 'callWall',
  put_wall: 'putWall',
};
const FIELD_KIND: Record<string, LevelKind> = { pdh: 'pdh', pdl: 'pdl' };

function levelStyle(l: Level): Pick<LevelSpec, 'color' | 'style' | 'dash'> {
  const kind = (l.concept ? CONCEPT_KIND[l.concept.concept] : undefined) ?? FIELD_KIND[l.source.field] ?? 'custom';
  const st = LEVEL_STYLES[kind];
  const style = st.dash.length === 0 ? 'solid' : st.dash[0]! <= 2 ? 'dot' : 'dash';
  const themed = kind === 'custom' ? customLevelColor(currentResolvedTheme()) : null;
  const alpha = colorChannels(st.line)?.[3] ?? 1;
  return { color: themed ? withAlpha(themed, alpha) : st.line, style, dash: st.dash };
}

export function vendorChip(level: Level): string | null {
  if (level.source.vendor === 'Tessera') return null;
  const base = `${level.source.vendor} · ${level.source.package}`;
  const conv = level.source.conversion;
  return conv ? `${base} · ${conv.from}→${level.instrument.split('.')[0] ?? level.instrument}` : base;
}

export function levelTitle(level: Level): string {
  const src = level.source;
  const head =
    level.price === null
      ? `${level.label}: ${level.unavailableReason ?? 'not available'}`
      : `${level.label} ${String(level.price)}`;
  const endpoint = src.endpoint ? ` (${src.endpoint})` : '';
  const parts = [head, `${src.vendor} ${src.package} field ${src.field}${endpoint}`];
  if (src.conversion) {
    const c = src.conversion;
    const native = level.nativePrice === null ? '' : ` ${String(level.nativePrice)}`;
    const add = c.additive ? ` ${c.additive < 0 ? '−' : '+'} ${String(Math.abs(c.additive))}` : '';
    parts.push(`converted from ${c.from}${native} × ${String(c.ratio)}${add} (${c.method})`);
  }
  return parts.join(' · ');
}

function toLevelSpec(l: Level): LevelSpec | null {
  if (l.price === null) return null;
  return {
    id: l.key,
    price: l.price,
    label: l.label,
    ...(l.short ? { short: l.short } : {}),
    vendor: vendorChip(l),
    ...levelStyle(l),
  };
}

export function toLevelSpecs(levels: readonly Level[], layers: readonly ChartLayer[]): LevelSpec[] {
  return levels.flatMap((l) => {
    const spec = isLevelShown(layers, l) ? toLevelSpec(l) : null;
    return spec ? [spec] : [];
  });
}

export function levelsForLayer(layer: ChartLayer, levels: readonly Level[]): LevelSpec[] {
  const fields = levelsParams(layer).fields;
  return levels.flatMap((l) => {
    if (!layerScopes(layer, l) || (fields && !fields.includes(l.source.field))) return [];
    const spec = toLevelSpec(l);
    return spec ? [spec] : [];
  });
}

export interface LevelGroup {
  label: string;
  levels: Level[];
}

const TESSERA_GROUPS: Record<string, string> = { pd: 'Levels', ib: 'Initial balance' };

export function groupLevels(levels: readonly Level[], layers: readonly ChartLayer[] = []): LevelGroup[] {
  const groups = new Map<string, LevelGroup & { rank: number; tessera: boolean }>();
  for (const l of levels) {
    const tessera = l.source.vendor === 'Tessera';
    if (tessera && LAYER_OWNED.has(l.group)) continue;
    const label = tessera ? (TESSERA_GROUPS[l.group] ?? l.group) : `${l.source.vendor} · ${l.source.package}`;
    const g = groups.get(label) ?? { label, levels: [], rank: Infinity, tessera };
    g.levels.push(l);
    const layer = layers.findIndex((x) => layerScopes(x, l));
    if (layer >= 0) g.rank = Math.min(g.rank, layer);
    groups.set(label, g);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.tessera) - Number(b.tessera) ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    )
    .map(({ label, levels: ls }) => ({ label, levels: ls }));
}
