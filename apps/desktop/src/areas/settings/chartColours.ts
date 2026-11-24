import type { JsonValue } from '@tessera/protocol';
import { hexOf } from '../../theme/colour.ts';
import {
  THEME_COLORS,
  themeKey,
  type ResolvedChartTheme,
  type ThemeGroup,
  type ThemeKey,
} from '../../chart/chartTheme.ts';

export const KEY = 'appearance.chartTheme';

export const BANDS: readonly { role: string; note?: string; groups: readonly ThemeGroup[] }[] = [
  { role: 'Palette', note: 'Everything below starts from these.', groups: ['palette'] },
  { role: 'Candles and volume', groups: ['candles', 'volume'] },
  { role: 'Canvas', groups: ['canvas', 'axis', 'crosshair', 'lastPrice', 'drawings'] },
  { role: 'Orders', note: 'Kept readable on the background.', groups: ['orders'] },
  { role: 'Levels', note: 'Each level’s own colour is picked in Levels.', groups: ['levels'] },
  { role: 'Order flow', groups: ['profile', 'footprint', 'delta', 'bigTrades'] },
];

export function zonesShown(r: ResolvedChartTheme): boolean {
  return (['orders.stopZone', 'orders.targetZone'] as const).some((k) => (r.colors[k]?.[3] ?? 0) > 0);
}

const CLEAR = hexOf([0, 0, 0, 0]);

export function zonesChange(on: boolean): JsonValue {
  const v = on ? null : CLEAR;
  return { orders: { stopZone: v, targetZone: v } };
}

const LABEL_OF: ReadonlyMap<string, string> = new Map(THEME_COLORS.map((c) => [themeKey(c), c.label]));

export function refusalWords(message: string, key?: string): string {
  const hidden = [...message.matchAll(/(orders\.\w+) #[0-9a-f]+ \(([\d.]+):1\)/g)].map((m) => ({
    key: m[1]!,
    ratio: m[2]!,
  }));
  if (message.includes('unreadable order colours') && hidden.length > 0) {
    const own = hidden.find((h) => h.key === key);
    if (own) return `Too close to the background to read (${own.ratio}:1; an order colour needs 3:1).`;
    const names = [...new Set(hidden.map((h) => LABEL_OF.get(h.key) ?? h.key))];
    const them = names.length > 1 ? 'them' : 'it';
    return `${names.join(', ')} would not read on this background. Change ${them} first, or pick another background.`;
  }
  return message.replace(/^appearance\.chartTheme: /, '');
}

export const COLOUR_KEYS: readonly ThemeKey[] = THEME_COLORS.filter((c) =>
  BANDS.some((b) => b.groups.includes(c.group)),
).map(themeKey);
