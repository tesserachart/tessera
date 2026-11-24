import type { ChartState } from '@tessera/protocol';

export const LINK_GROUPS = ['1', '2', '3', '4'] as const;
export type LinkGroup = (typeof LINK_GROUPS)[number];

function isLinkGroup(v: unknown): v is LinkGroup {
  return typeof v === 'string' && (LINK_GROUPS as readonly string[]).includes(v);
}

export function normalizeLink(v: unknown): LinkGroup | null {
  if (isLinkGroup(v)) return v;
  if (typeof v !== 'string') return null;
  const i = ['A', 'B', 'C', 'D'].indexOf(v.trim().toUpperCase());
  return i >= 0 ? LINK_GROUPS[i]! : null;
}

export function linkGroupsInUse(links: Iterable<unknown>): LinkGroup[] {
  const used = new Set<LinkGroup>();
  for (const l of links) {
    const g = normalizeLink(l);
    if (g) used.add(g);
  }
  return LINK_GROUPS.filter((g) => used.has(g));
}

export function showLinkColours(links: Iterable<unknown>): boolean {
  return linkGroupsInUse(links).length >= 2;
}

export function linkedCharts(charts: Readonly<Record<string, ChartState>>, tileId: string): string[] {
  const own = charts[tileId];
  if (!own) return [];
  const group = normalizeLink(own.linkGroup);
  if (!group) return [tileId];
  return [
    tileId,
    ...Object.keys(charts).filter((id) => id !== tileId && normalizeLink(charts[id]!.linkGroup) === group),
  ];
}

export function normalizeChartLinks(
  charts: Readonly<Record<string, ChartState>>,
  all: LinkGroup | null = null,
): Record<string, ChartState> | null {
  let changed = false;
  const out: Record<string, ChartState> = {};
  for (const [id, c] of Object.entries(charts)) {
    const next = all ?? normalizeLink(c.linkGroup);
    if (next !== c.linkGroup) changed = true;
    out[id] = next === c.linkGroup ? c : { ...c, linkGroup: next };
  }
  return changed ? out : null;
}
