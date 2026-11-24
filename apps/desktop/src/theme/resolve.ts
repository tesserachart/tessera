import { THEME_TABLES } from '@tessera/protocol';
import { luminance, parseHex, timesAlpha, type Rgba } from './colour.ts';

type Tables = typeof THEME_TABLES;
type ShellRow = Tables['shell'][number];
type ChartRow = Tables['colors'][number];
type Row = ShellRow | ChartRow;
type PathOf<T> = T extends { readonly group: infer G extends string; readonly key: infer K extends string }
  ? `${G}.${K}`
  : never;

export type ShellKey = PathOf<ShellRow>;
export type ChartKey = PathOf<ChartRow>;
export type ThemeKey = ShellKey | ChartKey;
export type ShellGroup = ShellRow['group'];
export type ChartGroup = ChartRow['group'];
type ThemeFontKey = Tables['fonts'][number]['key'];
type BuiltInId = Tables['builtIns'][number]['id'];
export type ChartPresetId = Tables['presets'][number]['id'];
export type ThemeMode = 'dark' | 'light';
export type UpDownPalette = 'tessera' | 'jade-coral';
export type BuiltIn = Tables['builtIns'][number];

export const SHELL_COLORS: readonly ShellRow[] = THEME_TABLES.shell;
export const CHART_COLORS: readonly ChartRow[] = THEME_TABLES.colors;
export const ALL_COLORS: readonly Row[] = [...SHELL_COLORS, ...CHART_COLORS];
export const BUILT_INS: readonly BuiltIn[] = THEME_TABLES.builtIns;
export const CHART_PRESETS = THEME_TABLES.presets;
export const THEME_FONTS = THEME_TABLES.fonts;
const UP_DOWN_PAIRS = THEME_TABLES.upDownPairs;

export const themeKey = <R extends Row>(c: R): PathOf<R> => `${c.group}.${c.key}` as PathOf<R>;

const UP_DOWN_ID: Record<UpDownPalette, keyof Tables['upDownPairs']> = {
  tessera: 'tessera',
  'jade-coral': 'jade_coral',
};

export interface ResolvedTheme {
  preset: BuiltInId;
  chartPreset: ChartPresetId;
  mode: ThemeMode;
  colors: Readonly<Record<ThemeKey, Rgba | null>>;
  explicit: ReadonlySet<ThemeKey>;
  overridden: ReadonlySet<ThemeKey>;
  fonts: Readonly<Record<ThemeFontKey, number>>;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function builtIn(id: unknown): BuiltIn {
  return BUILT_INS.find((t) => t.id === id) ?? BUILT_INS[0]!;
}

function ownColour(v: Record<string, unknown>, c: Row): Rgba | null {
  const group = v[c.group];
  const mine = isRecord(group) ? group[c.key] : undefined;
  return typeof mine === 'string' ? parseHex(mine) : null;
}

function listed(colors: Readonly<Record<string, string>>, key: string): Rgba | null {
  const hex = colors[key];
  return typeof hex === 'string' ? parseHex(hex) : null;
}

function modeOf(colors: Readonly<Record<ThemeKey, Rgba | null>>): ThemeMode {
  const ground = colors['surfaces.ground'];
  const text = colors['ink.t1'];
  return ground && text && luminance(ground) > luminance(text) ? 'light' : 'dark';
}

export function resolveTheme(value: unknown, updown: UpDownPalette = 'tessera'): ResolvedTheme {
  const v = isRecord(value) ? value : {};
  const theme = builtIn(v.preset);
  const chartPreset = CHART_PRESETS.find((p) => p.id === v.chartPreset) ?? CHART_PRESETS[0];
  const fromTheme = theme.colors as Readonly<Record<string, string>>;
  const fromChart = chartPreset.colors as Readonly<Record<string, string>>;
  const pair = UP_DOWN_PAIRS[UP_DOWN_ID[updown]];
  const colors: Partial<Record<ThemeKey, Rgba | null>> = {};
  const explicit = new Set<ThemeKey>();
  const overridden = new Set<ThemeKey>();
  for (const c of ALL_COLORS) {
    const key = themeKey(c);
    const own = ownColour(v, c);
    const given = listed(fromChart, key) ?? listed(fromTheme, key);
    let out: Rgba | null;
    if (own) {
      out = own;
      explicit.add(key);
      overridden.add(key);
    } else if (given) {
      out = given;
      explicit.add(key);
    } else if ('lit' in c.rule) {
      const fromPair = key === 'semantics.up' ? pair.up : key === 'semantics.down' ? pair.down : null;
      out = parseHex(fromPair ?? c.rule.lit);
    } else if ('from' in c.rule) {
      const src = colors[c.rule.from as ThemeKey];
      out = src ? timesAlpha(src, c.rule.alpha) : null;
    } else out = null;
    colors[key] = out;
  }
  const fontsIn = isRecord(v.fonts) ? v.fonts : {};
  const fonts = Object.fromEntries(
    THEME_FONTS.map((f) => {
      const x = fontsIn[f.key];
      return [f.key, typeof x === 'number' && x >= f.min && x <= f.max ? x : f.default];
    }),
  ) as Record<ThemeFontKey, number>;
  const resolved = colors as Record<ThemeKey, Rgba | null>;
  return {
    preset: theme.id,
    chartPreset: chartPreset.id,
    mode: modeOf(resolved),
    colors: resolved,
    explicit,
    overridden,
    fonts,
  };
}

export interface SavedTheme {
  id: string;
  name: string;
  theme: Record<string, unknown>;
}

export function readSaved(value: unknown): SavedTheme[] {
  const rows = isRecord(value) && Array.isArray(value.themes) ? value.themes : [];
  return rows.flatMap((r: unknown) =>
    isRecord(r) && typeof r.id === 'string' && typeof r.name === 'string' && isRecord(r.theme)
      ? [{ id: r.id, name: r.name, theme: r.theme }]
      : [],
  );
}

export interface EffectiveTheme {
  value: Record<string, unknown>;
  saved: SavedTheme | null;
}

export function effectiveTheme(active: unknown, saved: unknown): EffectiveTheme {
  const a = isRecord(active) ? active : {};
  const link = typeof a.saved === 'string' ? readSaved(saved).find((t) => t.id === a.saved) : undefined;
  if (link) return { value: link.theme, saved: link };
  const { saved: _drop, ...own } = a;
  return { value: own, saved: null };
}
