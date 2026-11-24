export const KEPT_WORKSPACES = 3;

export interface Kept {
  mounted: readonly string[];
  recent: readonly string[];
}

export function keepShown(kept: Kept | null, shown: string, max = KEPT_WORKSPACES): Kept {
  const recent = [shown, ...(kept?.recent ?? []).filter((id) => id !== shown)].slice(0, Math.max(1, max));
  const mounted = (kept?.mounted ?? []).filter((id) => recent.includes(id));
  if (!mounted.includes(shown)) mounted.push(shown);
  return { mounted, recent };
}

export function keepExisting(kept: Kept, exists: (id: string) => boolean): Kept {
  const shown = kept.recent[0];
  const keep = (id: string) => id === shown || exists(id);
  if (kept.mounted.every(keep)) return kept;
  return { mounted: kept.mounted.filter(keep), recent: kept.recent.filter(keep) };
}
