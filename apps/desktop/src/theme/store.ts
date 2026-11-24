import { z } from 'zod';
import { makeStore, patch, read, useStore, watch, write, type Readable } from '../app/store.ts';
import { uiStore } from '../state/ui.ts';
import { hexOf } from './colour.ts';
import { cssVarsOf, type ThemeCssVar } from './cssVars.ts';
import { readScheme, wantedMode, type Scheme } from './scheme.ts';
import {
  effectiveTheme,
  isRecord,
  readSaved,
  resolveTheme,
  type ResolvedTheme,
  type SavedTheme,
  type ThemeMode,
  type UpDownPalette,
} from './resolve.ts';

export const THEME_KEY = 'appearance.theme';
export const SAVED_THEMES_KEY = 'appearance.themes';

interface ThemeInputs {
  active: Record<string, unknown>;
  saved: Record<string, unknown>;
  scheme: Record<string, unknown>;
  system: ThemeMode;
}

const json = z.record(z.string(), z.unknown());

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

function systemQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(SYSTEM_DARK)
    : null;
}

const modeOfQuery = (q: MediaQueryList | null): ThemeMode => (q && !q.matches ? 'light' : 'dark');

const inputStore = makeStore<ThemeInputs>(
  { active: {}, saved: {}, scheme: {}, system: modeOfQuery(systemQuery()) },
  { persist: { key: 'tessera.theme', version: 1, fields: { active: json, saved: json, scheme: json } } },
);

export interface ThemeState {
  value: Record<string, unknown>;
  link: SavedTheme | null;
  savedThemes: readonly SavedTheme[];
  resolved: ResolvedTheme;
  vars: Readonly<Record<ThemeCssVar, string>>;
  scheme: Scheme;
  system: ThemeMode;
  wanted: ThemeMode;
}

function stateOf(inputs: ThemeInputs, updown: UpDownPalette): ThemeState {
  const { value, saved: link } = effectiveTheme(inputs.active, inputs.saved);
  const resolved = resolveTheme(value, updown);
  const scheme = readScheme(inputs.scheme);
  return {
    value,
    link,
    savedThemes: readSaved(inputs.saved),
    resolved,
    vars: cssVarsOf(resolved),
    scheme,
    system: inputs.system,
    wanted: wantedMode(scheme.appearance, inputs.system),
  };
}

const store = makeStore<ThemeState>(stateOf(read(inputStore), read(uiStore).updown));

const recompute = () => write(store, stateOf(read(inputStore), read(uiStore).updown));
watch(inputStore, recompute);
let lastUpdown = read(uiStore).updown;
watch(uiStore, (s) => {
  if (s.updown === lastUpdown) return;
  lastUpdown = s.updown;
  recompute();
});

export const themeStore: Readable<ThemeState> = store;

export function setThemeSettings(change: Partial<{ active: unknown; saved: unknown; scheme: unknown }>): void {
  const next: Partial<ThemeInputs> = {};
  if ('active' in change) next.active = isRecord(change.active) ? change.active : {};
  if ('saved' in change) next.saved = isRecord(change.saved) ? change.saved : {};
  if ('scheme' in change) next.scheme = isRecord(change.scheme) ? change.scheme : {};
  patch(inputStore, next);
}

export function setSystemMode(system: ThemeMode): void {
  if (read(inputStore).system !== system) patch(inputStore, { system });
}

export function installSystemMode(query: MediaQueryList | null = systemQuery()): () => void {
  if (!query) return () => undefined;
  const heard = () => setSystemMode(modeOfQuery(query));
  heard();
  query.addEventListener('change', heard);
  return () => query.removeEventListener('change', heard);
}

export function useTheme<T>(pick: (s: ThemeState) => T): T {
  return useStore(themeStore, pick);
}

export function currentTheme(): ThemeState {
  return read(themeStore);
}

function applyTheme(s: Pick<ThemeState, 'vars' | 'resolved'>, el: HTMLElement): void {
  for (const [name, value] of Object.entries(s.vars)) el.style.setProperty(name, value);
  el.style.colorScheme = s.resolved.mode;
  el.dataset.mode = s.resolved.mode;
}

export function installTheme(el: HTMLElement = document.documentElement): () => void {
  applyTheme(read(themeStore), el);
  return watch(themeStore, (s) => applyTheme(s, el));
}

export interface WindowAppearance {
  readonly setAppearance?: ((mode: ThemeMode | null, background: string) => Promise<void>) | undefined;
}

export function installWindowAppearance(win: WindowAppearance | null): () => void {
  const set = win?.setAppearance;
  if (!set) return () => undefined;
  const ground = (s: ThemeState) => {
    const c = s.resolved.colors['surfaces.ground'];
    return c ? hexOf([c[0], c[1], c[2], 255]) : null;
  };
  const frame = (s: ThemeState) => (s.scheme.appearance === 'system' ? null : s.resolved.mode);
  const show = (s: ThemeState) => {
    const bg = ground(s);
    if (!bg) return;
    set(frame(s), bg).catch((error: unknown) => {
      console.warn('[theme] the window kept its frame colours', error);
    });
  };
  show(read(themeStore));
  return watch(themeStore, (s, before) => {
    if (frame(s) !== frame(before) || ground(s) !== ground(before)) show(s);
  });
}
