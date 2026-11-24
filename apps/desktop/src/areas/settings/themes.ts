import {
  ALL_COLORS,
  BUILT_INS,
  builtIn,
  effectiveTheme,
  isRecord,
  resolveTheme,
  themeKey,
  type ResolvedTheme,
  type SavedTheme,
  type ShellGroup,
  type ThemeKey,
  type ThemeMode,
} from '../../theme/resolve.ts';
import { themeFor, type Appearance, type Scheme } from '../../theme/scheme.ts';

export const APP_BANDS: readonly { role: string; note?: string; groups: readonly ShellGroup[] }[] = [
  { role: 'Surfaces', note: 'The chart’s ground follows Ground unless the chart sets its own.', groups: ['surfaces'] },
  { role: 'Text', note: 'Kept readable on every surface.', groups: ['ink'] },
  { role: 'Lines', groups: ['lines'] },
  { role: 'Accents', groups: ['accents'] },
  { role: 'Meaning', note: 'Up, down, the analyst and limits, in the app and on the chart.', groups: ['semantics'] },
  { role: 'Order card', groups: ['card'] },
  { role: 'Link and tag colours', groups: ['categorical'] },
];

export type ThemeChoice = `builtin:${string}` | `saved:${string}`;

export interface ThemeOption {
  value: ThemeChoice;
  label: string;
  group: 'Built-in' | 'Saved';
  hint: string;
}

const MODE_WORD = { dark: 'Dark', light: 'Light' } as const;

export function themeOptions(saved: readonly SavedTheme[], mode?: ThemeMode, current?: ThemeChoice): ThemeOption[] {
  const all = everyTheme(saved);
  if (!mode) return all;
  return all.filter((o) => o.hint === MODE_WORD[mode] || o.value === current);
}

function everyTheme(saved: readonly SavedTheme[]): ThemeOption[] {
  return [
    ...BUILT_INS.map((t): ThemeOption => ({
      value: `builtin:${t.id}`,
      label: t.label,
      group: 'Built-in',
      hint: MODE_WORD[t.mode],
    })),
    ...saved.map((t): ThemeOption => ({
      value: `saved:${t.id}`,
      label: t.name,
      group: 'Saved',
      hint: MODE_WORD[resolveTheme(t.theme).mode],
    })),
  ];
}

export function savedWords(t: SavedTheme, shown: boolean): string {
  const r = resolveTheme(t.theme);
  return `${MODE_WORD[r.mode]} · from ${builtIn(r.preset).label}${shown ? ' · shown' : ''}`;
}

export function choiceOf(resolved: ResolvedTheme, link: SavedTheme | null): ThemeChoice {
  return link ? `saved:${link.id}` : `builtin:${resolved.preset}`;
}

export function keptChoice(theme: Record<string, unknown>, saved: readonly SavedTheme[]): ThemeChoice {
  const { value, saved: link } = effectiveTheme(theme, { themes: saved });
  return choiceOf(resolveTheme(value), link);
}

export interface ModeRow {
  mode: ThemeMode;
  shown: boolean;
  choice: ThemeChoice;
}

export function modeRows(
  shownMode: ThemeMode,
  shownChoice: ThemeChoice,
  scheme: Scheme,
  saved: readonly SavedTheme[],
): ModeRow[] {
  return (['dark', 'light'] as const).map((mode) =>
    mode === shownMode
      ? { mode, shown: true, choice: shownChoice }
      : { mode, shown: false, choice: keptChoice(themeFor(scheme, mode, saved), saved) },
  );
}

export function shownNowWords(resolved: ResolvedTheme, link: SavedTheme | null): string {
  return `Shown now${themeWords(resolved, link).slice(MODE_WORD[resolved.mode].length)}`;
}

export function whenShownWords(appearance: Appearance, mode: ThemeMode): string {
  return appearance === 'system'
    ? `Shown while your computer is in ${mode} mode.`
    : `Shown when Appearance is ${MODE_WORD[mode]}.`;
}

export function changeFor(choice: ThemeChoice): Record<string, string> {
  const [kind, id] = choice.split(/:(.*)/s) as [string, string];
  return kind === 'saved' ? { saved: id } : { preset: id };
}

export function themeWords(resolved: ResolvedTheme, link: SavedTheme | null): string {
  const own = resolved.overridden.size;
  const base = builtIn(resolved.preset).label;
  const from = link ? ` · from ${base}` : '';
  const mine =
    own > 0 ? ` · ${String(own)} ${own === 1 ? 'colour' : 'colours'} of your own${link ? '' : ` over ${base}`}` : '';
  return `${MODE_WORD[resolved.mode]}${from}${mine}`;
}

export function resetChange(resolved: ResolvedTheme, link: SavedTheme | null): Record<string, string> {
  return link ? { saved: link.id, preset: resolved.preset } : { preset: resolved.preset };
}

export function copyName(name: string, saved: readonly SavedTheme[]): string {
  const taken = (n: string) => saved.some((t) => t.name.toLowerCase() === n.toLowerCase());
  const base = `${name} copy`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base} ${String(n)}`)) return `${base} ${String(n)}`;
}

export function saveAsName(resolved: ResolvedTheme, link: SavedTheme | null, saved: readonly SavedTheme[]): string {
  return link ? copyName(link.name, saved) : copyName(builtIn(resolved.preset).label, saved);
}

const THEME_FILE_FORMAT = 'tessera-theme';

export function themeFile(name: string, theme: Record<string, unknown>): { name: string; text: string } {
  const file = `${name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'Theme'}.json`;
  return { name: file, text: `${JSON.stringify({ format: THEME_FILE_FORMAT, name, theme }, null, 2)}\n` };
}

export function readThemeFile(
  text: string,
  fileName: string,
): { name: string; theme: Record<string, unknown> } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: 'That file is not a theme.' };
  }
  if (!isRecord(parsed)) return { problem: 'That file is not a theme.' };
  const theme = isRecord(parsed.theme) ? parsed.theme : parsed;
  const named = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
  return { name: named ?? (fileName.replace(/\.json$/i, '').trim() || 'Imported theme'), theme };
}

const LABEL_OF: ReadonlyMap<string, string> = new Map(ALL_COLORS.map((c) => [themeKey(c), c.label]));

const labelOf = (key: string) => LABEL_OF.get(key) ?? key;

export function themeRefusal(message: string, key?: ThemeKey): string {
  const text = message.replace(/^appearance\.(theme|chartTheme|themes): /, '');
  const pairs = [...text.matchAll(/([a-z]+\.\w+) #[0-9a-f]+ on ([a-z]+\.\w+) #[0-9a-f]+ \(([\d.]+):1\)/gi)].map(
    (m) => ({ fg: m[1]!, bg: m[2]!, ratio: m[3]! }),
  );
  if (pairs.length === 0) return text.charAt(0).toUpperCase() + text.slice(1);
  const own = pairs.find((p) => p.fg === key || p.bg === key);
  if (own) {
    const other = own.fg === key ? own.bg : own.fg;
    return `Too close to ${labelOf(other)} to read (${own.ratio}:1; text needs 4.5:1).`;
  }
  const first = pairs[0]!;
  const more = pairs.length > 1 ? `, and ${String(pairs.length - 1)} more` : '';
  return `${labelOf(first.fg)} would not read on ${labelOf(first.bg)}${more}. Change ${labelOf(first.fg)} first.`;
}

export function upDownOwnWords(resolved: ResolvedTheme): string | null {
  const own = builtIn(resolved.preset);
  const set = own.colors as Readonly<Record<string, string>>;
  if ('semantics.up' in set || 'semantics.down' in set) return `${own.label} has its own up and down colours.`;
  if (resolved.overridden.has('semantics.up') || resolved.overridden.has('semantics.down'))
    return 'This theme sets its own up and down colours.';
  return null;
}
