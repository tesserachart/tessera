import { effectiveTheme, isRecord, resolveTheme, type SavedTheme, type ThemeMode } from './resolve.ts';

export const SCHEME_KEY = 'appearance.scheme';

export type Appearance = ThemeMode | 'system';

export interface Scheme {
  appearance: Appearance;
  dark: Record<string, unknown>;
  light: Record<string, unknown>;
}

const DEFAULT_THEME_OF: Readonly<Record<ThemeMode, Record<string, unknown>>> = {
  dark: {},
  light: { preset: 'tessera-light' },
};

const isAppearance = (v: unknown): v is Appearance => v === 'dark' || v === 'light' || v === 'system';

export function readScheme(value: unknown): Scheme {
  const v = isRecord(value) ? value : {};
  return {
    appearance: isAppearance(v.appearance) ? v.appearance : 'dark',
    dark: isRecord(v.dark) ? v.dark : DEFAULT_THEME_OF.dark,
    light: isRecord(v.light) ? v.light : DEFAULT_THEME_OF.light,
  };
}

export function wantedMode(appearance: Appearance, system: ThemeMode): ThemeMode {
  return appearance === 'system' ? system : appearance;
}

function showsIn(theme: Record<string, unknown>, mode: ThemeMode, saved: readonly SavedTheme[]): boolean {
  const link = theme.saved;
  if (link !== undefined && !saved.some((t) => t.id === link)) return false;
  return resolveTheme(effectiveTheme(theme, { themes: saved }).value).mode === mode;
}

export function themeFor(scheme: Scheme, mode: ThemeMode, saved: readonly SavedTheme[]): Record<string, unknown> {
  const theme = scheme[mode];
  return showsIn(theme, mode, saved) ? theme : DEFAULT_THEME_OF[mode];
}

export function showChange(theme: Record<string, unknown>): Record<string, unknown> {
  if (typeof theme.saved === 'string') return { saved: theme.saved };
  return { reset: true, ...theme };
}

export interface Shown {
  mode: ThemeMode;
  value: Record<string, unknown>;
  link: SavedTheme | null;
  savedThemes: readonly SavedTheme[];
}

function keptAs(shown: Pick<Shown, 'value' | 'link'>): Record<string, unknown> {
  return shown.link ? { saved: shown.link.id } : shown.value;
}

export interface Flip {
  keep: Partial<Record<ThemeMode, Record<string, unknown>>>;
  show: Record<string, unknown>;
}

export function flipTo(wanted: ThemeMode, shown: Shown, scheme: Scheme): Flip | null {
  if (shown.mode === wanted) return null;
  return {
    keep: { [shown.mode]: keptAs(shown) },
    show: showChange(themeFor(scheme, wanted, shown.savedThemes)),
  };
}
