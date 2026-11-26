import type { LevelSourceInfo, StyleHint } from '@tessera/protocol';
import type { LevelSpec } from '@tessera/chart';
import { defineSetting } from '../state/setting.ts';

export type LevelColor = 'mist' | 't2' | 'up' | 'down' | 'brass' | 'teal';
export const LEVEL_COLORS: readonly LevelColor[] = ['mist', 't2', 'up', 'down', 'brass', 'teal'];
export const COLOR_WORD: Record<LevelColor, string> = {
  mist: 'Mist',
  t2: 'Grey',
  up: 'Up',
  down: 'Down',
  brass: 'Brass',
  teal: 'Teal',
};

export type LevelLine = 'solid' | 'dash' | 'dot';
export const LEVEL_LINES: readonly LevelLine[] = ['solid', 'dash', 'dot'];
export const LINE_WORD: Record<LevelLine, string> = { solid: 'Solid', dash: 'Dashed', dot: 'Dotted' };

export type LevelLabel = 'name' | 'short' | 'none';
export const LEVEL_LABELS: readonly LevelLabel[] = ['name', 'short', 'none'];
export const LABEL_WORD: Record<LevelLabel, string> = { name: 'Name', short: 'Short', none: 'None' };

export interface LevelStyle {
  on: boolean;
  color: LevelColor;
  line: LevelLine;
  label: LevelLabel;
  distance: boolean;
}

export interface LevelDef {
  key: string;
  field: string;
  source: string;
  name: string;
  short: string;
  description: string | null;
  defaults: LevelStyle;
}

export interface SourceDef {
  key: string;
  name: string;
  note: string;
  levels: LevelDef[];
}

export type LevelDefs = ReadonlyMap<string, LevelDef>;

const style = (color: LevelColor, line: LevelLine, on = true): LevelStyle => ({
  on,
  color,
  line,
  label: 'name',
  distance: true,
});

export const PLAIN_STYLE: LevelStyle = style('mist', 'solid');

export const TESSERA_SOURCE: SourceDef = {
  key: 'tessera.concepts',
  name: 'Prior day',
  note: 'Tessera’s own, from the daily bars.',
  levels: (
    [
      ['pdh', 'Prior high', 'PDH'],
      ['pdl', 'Prior low', 'PDL'],
      ['pdc', 'Prior close', 'PDC'],
    ] as const
  ).map(([field, name, short]) => ({
    key: `tessera.concepts.${field}`,
    field,
    source: 'tessera.concepts',
    name,
    short,
    description: null,
    defaults: style('t2', 'dot'),
  })),
};

export const INITIAL_BALANCE_SOURCE: SourceDef = {
  key: 'tessera.ib',
  name: 'Initial balance',
  note: 'Tessera’s own.',
  levels: (
    [
      ['high', 'IB high', 'IBH', 'dash'],
      ['low', 'IB low', 'IBL', 'dash'],
      ['mid', 'IB mid', 'IBM', 'dot'],
      ['high50', 'IB +50%', 'IB+50', 'dot'],
      ['low50', 'IB −50%', 'IB−50', 'dot'],
      ['high100', 'IB +100%', 'IB+100', 'dot'],
      ['low100', 'IB −100%', 'IB−100', 'dot'],
    ] as const
  ).map(([field, name, short, line]) => ({
    key: `tessera.ib.${field}`,
    field,
    source: 'tessera.ib',
    name,
    short,
    description: null,
    defaults: style('mist', line),
  })),
};

export function sourceKeyOf(key: string): string {
  return key.split('.').slice(0, 2).join('.');
}

function fromHint(h: StyleHint | null | undefined): LevelStyle {
  return {
    ...PLAIN_STYLE,
    ...(h?.color ? { color: h.color } : {}),
    ...(h?.line ? { line: h.line } : {}),
    ...(h?.on === false ? { on: false } : {}),
  };
}

export function sourceDefs(infos: readonly LevelSourceInfo[]): SourceDef[] {
  const byKey = new Map<string, SourceDef>();
  for (const info of infos) {
    for (const p of info.packages) {
      const def = byKey.get(p.key) ?? {
        key: p.key,
        name: `${p.vendor} · ${p.package}`,
        note: info.schedule ?? `From ${info.displayName}.`,
        levels: [],
      };
      for (const l of p.levels) {
        if (def.levels.some((x) => x.key === l.key)) continue;
        def.levels.push({
          key: l.key,
          field: l.field,
          source: p.key,
          name: l.label,
          short: l.short ?? l.field,
          description: l.description ?? null,
          defaults: fromHint(l.style),
        });
      }
      byKey.set(p.key, def);
    }
  }
  return [...[...byKey.values()].filter((s) => s.levels.length > 0), TESSERA_SOURCE, INITIAL_BALANCE_SOURCE];
}

export function defsOf(sources: readonly SourceDef[]): Map<string, LevelDef> {
  return new Map(sources.flatMap((s) => s.levels.map((l) => [l.key, l] as const)));
}

export const BUILTIN_DEFS: LevelDefs = defsOf([TESSERA_SOURCE, INITIAL_BALANCE_SOURCE]);

export interface LevelSettings {
  sources: Partial<Record<string, boolean>>;
  levels: Partial<Record<string, Partial<LevelStyle>>>;
}

export const DEFAULT_LEVEL_SETTINGS: LevelSettings = { sources: {}, levels: {} };

export function defaultsOf(defs: LevelDefs, key: string): LevelStyle {
  return defs.get(key)?.defaults ?? BUILTIN_DEFS.get(key)?.defaults ?? PLAIN_STYLE;
}

export function levelStyle(s: LevelSettings, key: string, defs: LevelDefs = BUILTIN_DEFS): LevelStyle {
  return { ...defaultsOf(defs, key), ...(s.levels[key] ?? {}) };
}

export function sourceOn(s: LevelSettings, source: string): boolean {
  return s.sources[source] ?? true;
}

export function levelShown(s: LevelSettings, key: string, defs: LevelDefs = BUILTIN_DEFS): boolean {
  return sourceOn(s, sourceKeyOf(key)) && levelStyle(s, key, defs).on;
}

export function setLevelStyle(
  s: LevelSettings,
  key: string,
  patch: Partial<LevelStyle>,
  defs: LevelDefs = BUILTIN_DEFS,
): LevelSettings {
  const defaults = defaultsOf(defs, key);
  const next = { ...defaults, ...(s.levels[key] ?? {}), ...patch };
  const diff: Partial<LevelStyle> = {};
  for (const k of Object.keys(next) as (keyof LevelStyle)[]) {
    if (next[k] !== defaults[k]) (diff as Record<string, unknown>)[k] = next[k];
  }
  const levels = Object.fromEntries(Object.entries(s.levels).filter(([k]) => k !== key));
  if (Object.keys(diff).length > 0) levels[key] = diff;
  return { ...s, levels };
}

export function setSourceOn(s: LevelSettings, source: string, on: boolean): LevelSettings {
  return { ...s, sources: { ...s.sources, [source]: on } };
}

export interface Palette {
  mist: string;
  t2: string;
  up: string;
  down: string;
  brass: string;
  teal: string;
}

export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${String(parseInt(m[1]!, 16))},${String(parseInt(m[2]!, 16))},${String(parseInt(m[3]!, 16))},${String(alpha)})`;
}

const LINE_ALPHA: Record<LevelColor, number> = { mist: 0.55, t2: 0.5, up: 0.6, down: 0.6, brass: 0.6, teal: 0.8 };

export function swatchLine(p: Palette, c: LevelColor): string {
  return withAlpha(p[c], LINE_ALPHA[c]);
}

const DASH: Record<LevelLine, readonly number[]> = { solid: [], dash: [6, 4], dot: [1, 3] };

export function applyLevelSettings(
  spec: LevelSpec,
  s: LevelSettings,
  p: Palette,
  defs: LevelDefs = BUILTIN_DEFS,
): LevelSpec | null {
  const key = spec.id;
  if (!levelShown(s, key, defs)) return null;
  if (!defs.has(key) && !BUILTIN_DEFS.has(key) && !s.levels[key]) return spec;
  const st = levelStyle(s, key, defs);
  return {
    ...spec,
    color: swatchLine(p, st.color),
    style: st.line,
    dash: DASH[st.line],
    labelMode: st.label,
    distance: st.distance,
  };
}

const RENAMED: Record<string, string> = {
  pdh: 'tessera.concepts.pdh',
  pdl: 'tessera.concepts.pdl',
  pdc: 'tessera.concepts.pdc',
};
const RENAMED_SOURCES: Record<string, readonly string[]> = {
  prior: ['tessera.concepts'],
};

const SOURCE_KEY = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9_-]+$/;
const LEVEL_KEY = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9_-]+\..+$/;

const rank = (k: string) => (k in RENAMED ? 1 : 0);

export function readLevelSettings(v: unknown): LevelSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<LevelSettings>;
  const sources: LevelSettings['sources'] = {};
  for (const [id, on] of Object.entries((o.sources ?? {}) as Record<string, unknown>)) {
    if (typeof on !== 'boolean') continue;
    for (const k of RENAMED_SOURCES[id] ?? [id]) if (SOURCE_KEY.test(k)) sources[k] ??= on;
  }
  const levels: LevelSettings['levels'] = {};
  const entries = Object.entries((o.levels ?? {}) as Record<string, unknown>).sort(([a], [b]) => rank(a) - rank(b));
  for (const [raw, value] of entries) {
    const key = RENAMED[raw] ?? raw;
    if (!LEVEL_KEY.test(key) || !value || typeof value !== 'object' || levels[key]) continue;
    const r = value as Partial<LevelStyle>;
    const x: Partial<LevelStyle> = {};
    if (typeof r.on === 'boolean') x.on = r.on;
    if (LEVEL_COLORS.includes(r.color!)) x.color = r.color;
    if (LEVEL_LINES.includes(r.line!)) x.line = r.line;
    if (LEVEL_LABELS.includes(r.label!)) x.label = r.label;
    if (typeof r.distance === 'boolean') x.distance = r.distance;
    if (Object.keys(x).length) levels[key] = x;
  }
  return { sources, levels };
}

export const LEVELS = defineSetting('chart.levels', readLevelSettings);
