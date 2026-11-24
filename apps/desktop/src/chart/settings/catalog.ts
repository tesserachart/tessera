import { INDICATOR_SPECS, type IndicatorGroup, type IndicatorSpec } from '@tessera/protocol';

export const INDICATOR_GROUPS: readonly { group: IndicatorGroup; label: string }[] = [
  { group: 'custom', label: 'Yours' },
  { group: 'trend', label: 'Trend' },
  { group: 'momentum', label: 'Momentum' },
  { group: 'volatility', label: 'Volatility' },
  { group: 'volume', label: 'Volume' },
  { group: 'order_flow', label: 'Order flow' },
  { group: 'special', label: 'Special' },
];

export function groupLabel(group: IndicatorGroup): string {
  return INDICATOR_GROUPS.find((g) => g.group === group)?.label ?? group;
}

export function catalogGroups(
  specs: readonly IndicatorSpec[] = INDICATOR_SPECS,
): { group: IndicatorGroup; label: string; specs: IndicatorSpec[] }[] {
  return INDICATOR_GROUPS.map((g) => ({ ...g, specs: specs.filter((s) => s.group === g.group) })).filter(
    (g) => g.specs.length > 0,
  );
}

function score(spec: IndicatorSpec, q: string): number {
  const short = spec.short.toLowerCase();
  const title = spec.title.toLowerCase();
  if (short === q) return 100;
  if (short.startsWith(q)) return 80;
  if (title.startsWith(q)) return 70;
  if (title.split(/[\s-]+/).some((w) => w.startsWith(q))) return 60;
  if (short.includes(q) || title.includes(q)) return 40;
  if (groupLabel(spec.group).toLowerCase().startsWith(q)) return 20;
  const initials = title
    .split(/[\s-]+/)
    .map((w) => w[0] ?? '')
    .join('');
  if (initials.startsWith(q)) return 50;
  return 0;
}

export function searchIndicators(query: string, specs: readonly IndicatorSpec[] = INDICATOR_SPECS): IndicatorSpec[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...specs];
  return specs
    .map((spec, order) => {
      const scores = words.map((w) => score(spec, w));
      return { spec, order, score: scores.some((s) => s === 0) ? 0 : scores.reduce((a, b) => a + b, 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.spec);
}
