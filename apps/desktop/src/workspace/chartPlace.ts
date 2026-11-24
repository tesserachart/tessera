import { popped, workspaceContext } from './controller.ts';
import { chartPanelIds } from './layouts.ts';

export interface PlaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function placeWords(box: PlaceBox, area: PlaceBox): string {
  const across = (box.x + box.w / 2 - area.x) / Math.max(1, area.w);
  const down = (box.y + box.h / 2 - area.y) / Math.max(1, area.h);
  const side = across < 0.4 ? 'left' : across > 0.6 ? 'right' : '';
  const level = down < 0.4 ? 'top' : down > 0.6 ? 'bottom' : '';
  const words = [level, side].filter(Boolean).join(' ') || 'centre';
  return words[0]!.toUpperCase() + words.slice(1);
}

const boxOf = (r: DOMRect): PlaceBox => ({ x: r.left, y: r.top, w: r.width, h: r.height });

function union(boxes: readonly PlaceBox[]): PlaceBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

export function chartPlace(layoutId: string, tileId: string): string | null {
  const ctx = workspaceContext();
  if (ctx?.layoutId !== layoutId) return null;
  const panel = ctx.api.getPanel(tileId);
  if (!panel) {
    if (popped(layoutId).has(tileId)) return 'Pop-out window';
    return ctx.popout ? 'Main window' : null;
  }
  const own = boxOf(panel.group.element.getBoundingClientRect());
  const groups = chartPanelIds(ctx.api).flatMap((id) => {
    const g = ctx.api.getPanel(id)?.group.element.getBoundingClientRect();
    return g ? [boxOf(g)] : [];
  });
  const at = placeWords(own, union([own, ...groups]));
  const tabs = panel.group.panels;
  return tabs.length > 1 ? `${at}, tab ${String(tabs.indexOf(panel) + 1)}` : at;
}
