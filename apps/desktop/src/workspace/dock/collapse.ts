import type { DockviewApi } from 'dockview-react';
import { tesseraDockTheme } from '../dockTheme.ts';
import { EDGE_SPEC, EDGE_STRIP, edgeGroup, type EdgePos } from './edges.ts';
import { collapseEdge, expandEdge } from './motion.ts';

export interface CollapseDrag {
  collapsed: boolean;
  lastOpen: number;
  proposed: number;
  strip: number;
  minOpen: number;
}

export function planCollapseDrag(input: CollapseDrag): { collapsed: boolean; lastOpen: number } {
  const last = Math.max(input.minOpen, input.lastOpen);
  if (input.collapsed) {
    if (input.proposed > input.strip) return { collapsed: false, lastOpen: Math.max(last, input.proposed) };
    return { collapsed: true, lastOpen: last };
  }
  if (input.proposed <= input.minOpen) return { collapsed: true, lastOpen: last };
  return { collapsed: false, lastOpen: Math.max(input.minOpen, input.proposed) };
}

export function edgeBesideSash(api: DockviewApi, sash: Element): EdgePos | null {
  const split = sash.closest('.dv-split-view-container');
  if (!split) return null;
  const sashes = [...split.querySelectorAll(':scope > .dv-sash-container > .dv-sash')];
  const views = [...split.querySelectorAll(':scope > .dv-view-container > .dv-view')];
  const i = sashes.indexOf(sash);
  if (i < 0) return null;
  const holds = (view: Element | undefined, pos: EdgePos) => {
    const el = edgeGroup(api, pos)?.element;
    return !!el && !!view && view.contains(el);
  };
  if (split.classList.contains('dv-vertical')) {
    return holds(views[i], 'bottom') || holds(views[i + 1], 'bottom') ? 'bottom' : null;
  }
  if (holds(views[i], 'left') || holds(views[i + 1], 'left')) return 'left';
  if (holds(views[i], 'right') || holds(views[i + 1], 'right')) return 'right';
  return null;
}

function edgeSize(api: DockviewApi, pos: EdgePos): number {
  const g = api.getEdgeGroup(pos);
  if (!g) return EDGE_SPEC[pos].initial;
  return pos === 'bottom' ? g.height : g.width;
}

function rememberOpen(api: DockviewApi, pos: EdgePos, size: number): void {
  const g = api.getEdgeGroup(pos);
  if (!g) return;
  g.setSize(pos === 'bottom' ? { height: size } : { width: size });
}

export function installCollapsibleEdges(api: DockviewApi, root: HTMLElement): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const sash = (e.target as Element | null)?.closest('.dv-sash');
    if (!sash || !root.contains(sash)) return;
    const pos = edgeBesideSash(api, sash);
    if (!pos) return;
    const g = api.getEdgeGroup(pos);
    if (!g || !api.isEdgeGroupVisible(pos)) return;
    const fromStrip = g.isCollapsed();
    if (fromStrip) {
      expandEdge(api, pos, 'key');
      e.stopPropagation();
    }
    const start = edgeSize(api, pos);
    const floor = EDGE_SPEC[pos].min + (tesseraDockTheme.gap ?? 0);
    const doc = sash.ownerDocument;
    const onUp = () => {
      doc.removeEventListener('pointerup', onUp, true);
      doc.removeEventListener('pointercancel', onUp, true);
      const now = api.getEdgeGroup(pos);
      if (!now || now.isCollapsed()) return;
      if (fromStrip) {
        if (edgeSize(api, pos) <= floor) rememberOpen(api, pos, start);
        return;
      }
      const plan = planCollapseDrag({
        collapsed: false,
        lastOpen: start,
        proposed: edgeSize(api, pos),
        strip: EDGE_STRIP,
        minOpen: floor,
      });
      if (!plan.collapsed) return;
      collapseEdge(api, pos, 'key');
      rememberOpen(api, pos, plan.lastOpen);
    };
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onUp, true);
  };
  root.addEventListener('pointerdown', onDown, true);
  return () => root.removeEventListener('pointerdown', onDown, true);
}
