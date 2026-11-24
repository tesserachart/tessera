import type { AreaId } from './store.ts';

export const RAIL_TILE_TYPE = 'application/x-tessera-tile';

interface RailDrag {
  kind: string;
  from: AreaId;
  dropped: boolean;
}

let current: RailDrag | null = null;

export function railDragKind(): string | null {
  return current?.kind ?? null;
}

export function beginRailDrag(kind: string, from: AreaId): void {
  current = { kind, from, dropped: false };
}

export function markRailDropped(): void {
  if (current) current.dropped = true;
}

export function endRailDrag(): RailDrag | null {
  const d = current;
  current = null;
  return d;
}
