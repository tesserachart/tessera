import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import type { ReturnDirection, ReturnPlace } from '../../state/layouts.ts';
import { placeOf, type PanelPlace } from './edges.ts';

interface GroupBox {
  id: string;
  place: PanelPlace;
  others: number;
  rect: { left: number; top: number; width: number; height: number };
}

export function returnToOf(own: GroupBox & { index: number }, groups: readonly GroupBox[]): ReturnPlace | null {
  if (own.others > 0 || (own.place !== 'centre' && own.place !== 'floating' && own.place !== 'popout')) {
    return { referenceGroupId: own.id, direction: 'within', index: own.index };
  }
  const cx = own.rect.left + own.rect.width / 2;
  const cy = own.rect.top + own.rect.height / 2;
  let best: { g: GroupBox; d: number } | null = null;
  for (const g of groups) {
    if (g.id === own.id || g.place !== 'centre') continue;
    const gx = g.rect.left + g.rect.width / 2;
    const gy = g.rect.top + g.rect.height / 2;
    const d = Math.hypot(gx - cx, gy - cy);
    if (!best || d < best.d) best = { g, d };
  }
  if (!best) return null;
  const r = best.g.rect;
  const direction: ReturnDirection =
    cx >= r.left + r.width ? 'right' : cx <= r.left ? 'left' : cy >= r.top + r.height ? 'below' : 'above';
  return { referenceGroupId: best.g.id, direction };
}

export function returnPlaceOf(api: DockviewApi, leaving: IDockviewPanel): ReturnPlace | null {
  const boxes = api.groups.map((g): GroupBox => {
    const r = g.element.getBoundingClientRect();
    return {
      id: g.id,
      place: placeOf(g),
      others: g.panels.filter((p) => p.id !== leaving.id).length,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  });
  const own = boxes.find((g) => g.id === leaving.group.id);
  return own ? returnToOf({ ...own, index: leaving.group.panels.indexOf(leaving) }, boxes) : null;
}
