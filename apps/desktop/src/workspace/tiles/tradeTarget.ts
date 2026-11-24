export interface TradeTargetInput {
  layoutId: string;
  active: { layoutId: string; tileId: string } | null;
  layoutActive: string | null;
  docked: readonly string[];
}

export function tradeChartOf(i: TradeTargetInput): string | null {
  if (i.active?.layoutId === i.layoutId && i.docked.includes(i.active.tileId)) return i.active.tileId;
  if (i.layoutActive && i.docked.includes(i.layoutActive)) return i.layoutActive;
  return i.docked[0] ?? null;
}
