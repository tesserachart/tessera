import type { DockviewApi } from 'dockview-react';
import { EDGE_STRIP, edgeGroup, edgeInitialSize, type EdgePos } from './edges.ts';

export type AutoEdge = 'left' | 'bottom';

export const RESPONSIVE = {
  leftBelow: 920,
  leftReturn: 960,
  bottomBelow: 760,
  bottomReturn: 800,
  centreMin: 560,
} as const;

interface EdgeState {
  visible: boolean;
  collapsed: boolean;
  size: number;
}

export interface ResponsiveInput {
  width: number;
  height: number;
  left: EdgeState | null;
  right: EdgeState | null;
  bottom: EdgeState | null;
  auto: ReadonlySet<AutoEdge>;
  held: ReadonlySet<AutoEdge>;
  keep?: ReadonlySet<AutoEdge>;
}

export interface ResponsivePlan {
  collapse: AutoEdge[];
  restore: AutoEdge[];
  release: AutoEdge[];
}

function taken(e: EdgeState | null): number {
  if (!e?.visible) return 0;
  return e.collapsed ? EDGE_STRIP : e.size;
}

export function centreWithLeftOpen(input: Pick<ResponsiveInput, 'width' | 'left' | 'right'>): number {
  const left = input.left?.visible ? input.left.size : 0;
  return input.width - taken(input.right) - left;
}

export function centreWidth(input: Pick<ResponsiveInput, 'width' | 'left' | 'right'>): number {
  return input.width - taken(input.right) - taken(input.left);
}

export function planResponsive(input: ResponsiveInput, opts: { settled?: boolean } = {}): ResponsivePlan {
  const plan: ResponsivePlan = { collapse: [], restore: [], release: [] };
  if (input.width <= 0 || input.height <= 0) return plan;
  const leftReturn = opts.settled ? RESPONSIVE.leftBelow : RESPONSIVE.leftReturn;
  const bottomReturn = opts.settled ? RESPONSIVE.bottomBelow : RESPONSIVE.bottomReturn;
  const centre = centreWithLeftOpen(input);
  const left = input.left;
  if (left?.visible) {
    if (input.auto.has('left')) {
      if (centre >= leftReturn) plan.restore.push('left');
    } else if (input.held.has('left')) {
      if (centre >= leftReturn) plan.release.push('left');
    } else if (!left.collapsed && centre < RESPONSIVE.leftBelow && !input.keep?.has('left')) plan.collapse.push('left');
  }
  const bottom = input.bottom;
  if (bottom?.visible) {
    if (input.auto.has('bottom')) {
      if (input.height >= bottomReturn) plan.restore.push('bottom');
    } else if (input.held.has('bottom')) {
      if (input.height >= bottomReturn) plan.release.push('bottom');
    } else if (!bottom.collapsed && input.height < RESPONSIVE.bottomBelow && !input.keep?.has('bottom'))
      plan.collapse.push('bottom');
  }
  return plan;
}

export function planHandExpand(input: ResponsiveInput, opened: EdgePos): AutoEdge | null {
  if (centreWidth(input) >= RESPONSIVE.centreMin) return null;
  const open = (pos: AutoEdge, e: EdgeState | null) =>
    opened !== pos && e?.visible && !e.collapsed && !input.keep?.has(pos);
  if (open('left', input.left)) return 'left';
  if (open('bottom', input.bottom)) return 'bottom';
  return null;
}

function openSize(api: DockviewApi, pos: EdgePos, remembered: Map<EdgePos, number>): number {
  const g = api.getEdgeGroup(pos);
  if (!g) return 0;
  const now = pos === 'bottom' ? g.height : g.width;
  if (!g.isCollapsed() && now > EDGE_STRIP) {
    remembered.set(pos, now);
    return now;
  }
  return remembered.get(pos) ?? edgeInitialSize(pos, typeof window === 'undefined' ? api.width : window.innerWidth);
}

/** dockview's own `width` and `height` are the centre grid's, without the edges. */
export function responsiveInputOf(
  api: DockviewApi,
  host: Pick<HTMLElement, 'clientWidth' | 'clientHeight'>,
  auto: ReadonlySet<AutoEdge>,
  held: ReadonlySet<AutoEdge>,
  remembered = new Map<EdgePos, number>(),
  roomOf: (kind: string) => number = () => 0,
): ResponsiveInput {
  const edge = (pos: EdgePos): EdgeState | null => {
    const g = api.getEdgeGroup(pos);
    if (!g) return null;
    return { visible: api.isEdgeGroupVisible(pos), collapsed: g.isCollapsed(), size: openSize(api, pos, remembered) };
  };
  const keep = new Set<AutoEdge>();
  for (const pos of ['left', 'bottom'] as const) {
    if (edgeGroup(api, pos)?.panels.some((p) => roomOf(p.api.component) > 0)) keep.add(pos);
  }
  return {
    width: host.clientWidth,
    height: host.clientHeight,
    left: edge('left'),
    right: edge('right'),
    bottom: edge('bottom'),
    auto,
    held,
    keep,
  };
}
