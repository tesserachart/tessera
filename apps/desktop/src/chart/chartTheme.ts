import { TESSERA_THEME, type ChartFlowTheme, type ChartTheme } from '@tessera/chart';
import { TOKENS } from '@tessera/ui';
import { derived, read, useStore, type Readable } from '../app/store.ts';
import { cssOf, hexOf, luminance, mix, TRANSPARENT, timesAlpha, type Rgba } from '../theme/colour.ts';
import {
  CHART_COLORS,
  CHART_PRESETS,
  THEME_FONTS,
  themeKey,
  type ChartGroup,
  type ChartKey,
  type ChartPresetId,
  type ResolvedTheme,
  type ThemeKey,
} from '../theme/resolve.ts';
import { themeStore, type ThemeState } from '../theme/store.ts';

export type { ChartGroup as ThemeGroup, ChartKey, ThemeKey };
export type { ResolvedTheme as ResolvedChartTheme } from '../theme/resolve.ts';
export { resolveTheme as resolveChartTheme } from '../theme/resolve.ts';

export const THEME_COLORS = CHART_COLORS;
export { THEME_FONTS, themeKey };
export const THEME_PRESETS = CHART_PRESETS;
export type PresetId = ChartPresetId;

function themeCss(r: ResolvedTheme, key: ThemeKey): string {
  const c = r.colors[key];
  return c ? cssOf(c) : TRANSPARENT;
}

export function themeHex(r: ResolvedTheme, key: ThemeKey): string | null {
  const c = r.colors[key];
  return c ? hexOf(c) : null;
}

const rgbOf = (c: Rgba | null): string => (c ? `${String(c[0])},${String(c[1])},${String(c[2])}` : '0,0,0');

function tagInks(r: ResolvedTheme): { dark: ThemeKey; light: ThemeKey } {
  const ground = r.colors['palette.background'];
  const text = r.colors['palette.text'];
  const groundIsDarker = !ground || !text || luminance(ground) <= luminance(text);
  return groundIsDarker
    ? { dark: 'palette.background', light: 'palette.text' }
    : { dark: 'palette.text', light: 'palette.background' };
}

export function chartThemeOf(r: ResolvedTheme): ChartTheme {
  const css = (k: ThemeKey) => themeCss(r, k);
  const at = (k: ThemeKey, a: number) => {
    const c = r.colors[k];
    return c ? cssOf(timesAlpha(c, a)) : TRANSPARENT;
  };
  const flow: ChartFlowTheme = {
    volume: rgbOf(r.colors['footprint.volume']),
    ask: rgbOf(r.colors['footprint.ask']),
    bid: rgbOf(r.colors['footprint.bid']),
    imbalanceAsk: css('footprint.imbalanceAsk'),
    imbalanceBid: css('footprint.imbalanceBid'),
    text: css('footprint.text'),
    poc: css('footprint.poc'),
    bubbleBuy: css('bigTrades.buy'),
    bubbleSell: css('bigTrades.sell'),
    deltaUp: css('delta.positive'),
    deltaDown: css('delta.negative'),
    profileBar: css('profile.bar'),
    profileValueArea: css('profile.valueArea'),
    profilePoc: css('profile.poc'),
    profileBuy: css('profile.buy'),
    profileSell: css('profile.sell'),
  };
  const handles = r.colors['drawings.handles'];
  const inks = tagInks(r);
  return {
    ...TESSERA_THEME,
    background: css('palette.background'),
    grid: css('canvas.gridHorizontal'),
    gridVertical: css('canvas.gridVertical'),
    border: css('canvas.border'),
    sessionSeparator: css('canvas.sessions'),
    text: css('palette.text'),
    mutedText: css('axis.text'),
    subtleText: css('palette.subtle'),
    labelText: css('axis.text'),
    dayText: css('axis.day'),
    upFill: css('candles.upBody'),
    downFill: css('candles.downBody'),
    upWick: css('candles.upWick'),
    downWick: css('candles.downWick'),
    upBorder: css('candles.upBorder'),
    downBorder: css('candles.downBorder'),
    upBar: css('candles.barUp'),
    downBar: css('candles.barDown'),
    lineSeries: css('candles.line'),
    upVolume: at('volume.up', 0.24),
    downVolume: at('volume.down', 0.28),
    upText: css('palette.up'),
    downText: css('palette.down'),
    agent: css('palette.analyst'),
    hazard: css('palette.hazard'),
    crosshair: css('crosshair.line'),
    tagBackground: css('crosshair.label'),
    tagInk: css(inks.dark),
    tagInkLight: css(inks.light),
    lastPrice: css('lastPrice.label'),
    lastPriceLine: css('lastPrice.line'),
    font: TOKENS.sans,
    fontMono: TOKENS.sans,
    fontFig: TOKENS.fig,
    fontSize: r.fonts.size,
    priceFontSize: r.fonts.priceSize,
    handles: handles ? cssOf(handles) : null,
    flow,
  };
}

export function swatchesOf(r: ResolvedTheme): Record<string, string> {
  const css = (k: ThemeKey) => themeCss(r, k);
  const muted = r.colors['palette.muted'];
  const ground = r.colors['palette.background'];
  const ownChart = r.explicit.has('palette.muted') || r.explicit.has('palette.background');
  const t4 =
    !ownChart || !muted || !ground ? css('ink.t4') : cssOf(mix(muted, ground, 0.35).map(Math.round) as unknown as Rgba);
  return {
    mist: css('palette.mist'),
    t1: css('palette.text'),
    t2: css('palette.subtle'),
    t3: css('palette.muted'),
    t4,
    up: css('palette.up'),
    down: css('palette.down'),
    brass: css('palette.hazard'),
    teal: css('accents.teal'),
    aqua: css('palette.analyst'),
  };
}

export function swatchesFor(r: ResolvedTheme, kind: string): Record<string, string> {
  const base = swatchesOf(r);
  const pair: Partial<Record<string, [ThemeKey, ThemeKey]>> = {
    volume: ['volume.up', 'volume.down'],
    delta: ['delta.positive', 'delta.negative'],
  };
  const p = pair[kind];
  return p ? { ...base, up: themeCss(r, p[0]), down: themeCss(r, p[1]) } : base;
}

const STUDY_THEME_KEYS: Readonly<Record<string, readonly ChartKey[]>> = {
  volume: ['volume.up', 'volume.down'],
  delta: ['delta.positive', 'delta.negative'],
  big_trades: ['bigTrades.buy', 'bigTrades.sell'],
  stacked_imbalance: ['footprint.ask', 'footprint.bid'],
  volume_profile: ['profile.bar', 'profile.valueArea', 'profile.poc', 'profile.buy', 'profile.sell'],
  market_profile: ['profile.bar', 'profile.valueArea', 'profile.poc'],
  footprint: [
    'footprint.ask',
    'footprint.bid',
    'footprint.imbalanceAsk',
    'footprint.imbalanceBid',
    'footprint.volume',
    'footprint.text',
    'footprint.poc',
  ],
};

export function studyThemeKeys(kind: string): readonly ChartKey[] {
  return STUDY_THEME_KEYS[kind] ?? [];
}

export function studyColorsChanged(r: ResolvedTheme, kind: string): boolean {
  return studyThemeKeys(kind).some((k) => r.overridden.has(k));
}

export function themeChange(key: ThemeKey, hex: string | null): Record<string, Record<string, string | null>> {
  const [group, name] = key.split('.') as [string, string];
  return { [group]: { [name]: hex } };
}

export function orderColorsOf(r: ResolvedTheme) {
  return {
    mist: themeCss(r, 'orders.position'),
    t2: themeCss(r, 'orders.working'),
    t3: themeCss(r, 'palette.muted'),
    aqua: themeCss(r, 'orders.draft'),
    up: themeCss(r, 'orders.target'),
    down: themeCss(r, 'orders.stop'),
    upZone: themeCss(r, 'orders.targetZone'),
    downZone: themeCss(r, 'orders.stopZone'),
  };
}

export function customLevelColor(r: ResolvedTheme): string | null {
  const c = r.colors['levels.custom'];
  return c ? cssOf(c) : null;
}

interface ChartThemeState {
  resolved: ResolvedTheme;
  theme: ChartTheme;
  swatches: Readonly<Record<string, string>>;
  vars: Readonly<Record<'--chart-bg', string>>;
}

function chartStateOf(s: ThemeState): ChartThemeState {
  return {
    resolved: s.resolved,
    theme: chartThemeOf(s.resolved),
    swatches: swatchesOf(s.resolved),
    vars: { '--chart-bg': themeCss(s.resolved, 'palette.background') },
  };
}

export const chartThemeStore: Readable<ChartThemeState> = derived(themeStore, chartStateOf);

export function useChartTheme<T>(pick: (s: ChartThemeState) => T): T {
  return useStore(chartThemeStore, pick);
}

export function currentResolvedTheme(): ResolvedTheme {
  return read(chartThemeStore).resolved;
}
