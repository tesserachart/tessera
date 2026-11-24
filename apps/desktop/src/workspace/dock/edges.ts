import type { DockviewApi, DockviewGroupPanel, IDockviewGroupPanel } from 'dockview-react';

export const EDGES = ['left', 'right', 'bottom'] as const;
export type EdgePos = (typeof EDGES)[number];
export type DockArea = EdgePos | 'centre';

export interface EdgeSpec {
  id: string;
  initial: number;
  initialNarrow: number;
  min: number;
  max: number | null;
}

export const EDGE_SPEC: Record<EdgePos, EdgeSpec> = {
  left: { id: 'edge-left', initial: 256, initialNarrow: 216, min: 200, max: 360 },
  right: { id: 'edge-right', initial: 392, initialNarrow: 344, min: 320, max: 640 },
  bottom: { id: 'edge-bottom', initial: 192, initialNarrow: 192, min: 120, max: null },
};

export const EDGE_STRIP = 38;

export const NARROW_WINDOW_W = 1600;

export function isEdgePos(v: unknown): v is EdgePos {
  return typeof v === 'string' && (EDGES as readonly string[]).includes(v);
}

export function edgeOfGroupId(id: string): EdgePos | null {
  for (const p of EDGES) if (EDGE_SPEC[p].id === id) return p;
  return null;
}

export function edgeInitialSize(pos: EdgePos, width: number): number {
  return width > 0 && width < NARROW_WINDOW_W ? EDGE_SPEC[pos].initialNarrow : EDGE_SPEC[pos].initial;
}

function windowWidth(api: Pick<DockviewApi, 'width'>): number {
  return typeof window === 'undefined' ? api.width : window.innerWidth;
}

export function clampEdgeSize(pos: EdgePos, size: number, dockHeight = 0): number {
  const spec = EDGE_SPEC[pos];
  const max = spec.max ?? (dockHeight > 0 ? Math.max(spec.min, Math.floor(dockHeight / 2)) : Number.POSITIVE_INFINITY);
  return Math.round(Math.min(max, Math.max(spec.min, size)));
}

export function edgeOf(group: Pick<IDockviewGroupPanel, 'id' | 'api'> | null | undefined): EdgePos | null {
  if (group?.api.location.type !== 'edge') return null;
  return edgeOfGroupId(group.id);
}

export type PanelPlace = DockArea | 'floating' | 'popout';

export function placeOf(group: Pick<IDockviewGroupPanel, 'id' | 'api'>): PanelPlace {
  const t = group.api.location.type;
  if (t === 'floating') return 'floating';
  if (t === 'popout') return 'popout';
  return edgeOf(group) ?? 'centre';
}

export function edgeGroup(api: DockviewApi, pos: EdgePos): DockviewGroupPanel | null {
  return api.groups.find((g): g is DockviewGroupPanel => g.id === EDGE_SPEC[pos].id) ?? null;
}

function edgePanels(api: DockviewApi, pos: EdgePos): DockviewGroupPanel['panels'] {
  return edgeGroup(api, pos)?.panels ?? [];
}

export function ensureEdges(
  api: DockviewApi,
  opts: { collapsed?: Partial<Record<EdgePos, boolean>>; sizes?: Partial<Record<EdgePos, number>> } = {},
): void {
  for (const pos of EDGES) {
    if (api.getEdgeGroup(pos)) continue;
    const spec = EDGE_SPEC[pos];
    const max = spec.max ?? Math.max(spec.min, Math.floor((api.height || 2 * spec.initial) / 2));
    api.addEdgeGroup(pos, {
      id: spec.id,
      initialSize: clampEdgeSize(pos, opts.sizes?.[pos] ?? edgeInitialSize(pos, windowWidth(api)), api.height),
      minimumSize: spec.min,
      maximumSize: max,
      collapsedSize: EDGE_STRIP,
      collapsed: opts.collapsed?.[pos] ?? false,
    });
  }
}

export function syncEdgeChrome(api: DockviewApi): void {
  for (const pos of EDGES) {
    const g = api.getEdgeGroup(pos);
    if (!g) continue;
    const empty = edgePanels(api, pos).length === 0;
    if (api.isEdgeGroupVisible(pos) === empty) api.setEdgeGroupVisible(pos, !empty);
    const header = g.isCollapsed() ? pos : 'top';
    if (g.getHeaderPosition() !== header) g.setHeaderPosition(header);
  }
}

export function edgeFitSize(pos: EdgePos, now: number, rooms: readonly number[], dockHeight = 0): number | null {
  const need = Math.max(0, ...rooms);
  if (need <= 0) return null;
  const size = clampEdgeSize(pos, need, dockHeight);
  return size > now + 0.5 ? size : null;
}

type Fitted = Map<EdgePos, { from: number; to: number }>;
const fitted = new WeakMap<object, Fitted>();

export function fitEdges(api: DockviewApi, roomOf: (kind: string) => number): void {
  let mine = fitted.get(api);
  if (!mine) {
    mine = new Map() as Fitted;
    fitted.set(api, mine);
  }
  for (const pos of EDGES) {
    const g = api.getEdgeGroup(pos);
    if (!g || !edgeGroup(api, pos) || g.isCollapsed() || !api.isEdgeGroupVisible(pos)) continue;
    const now = pos === 'bottom' ? g.height : g.width;
    if (!(now > EDGE_STRIP)) continue;
    const rooms = edgePanels(api, pos).map((p) => roomOf(p.api.component));
    const was = mine.get(pos);
    if (was && Math.abs(now - was.to) > 1) mine.delete(pos);
    const size = edgeFitSize(pos, now, rooms);
    const set = (v: number) => g.setSize(pos === 'bottom' ? { height: v } : { width: v });
    if (size !== null) {
      mine.set(pos, { from: mine.get(pos)?.from ?? now, to: size });
      set(size);
    } else if (mine.has(pos) && !rooms.some((r) => r > 0)) {
      set(mine.get(pos)!.from);
      mine.delete(pos);
    }
  }
}

const momentary = new Set<EdgePos>();
export function markMomentary(pos: EdgePos, on: boolean): void {
  if (on) momentary.add(pos);
  else momentary.delete(pos);
}
export function isMomentary(pos: EdgePos): boolean {
  return momentary.has(pos);
}
export function momentaryOpen(): Partial<Record<EdgePos, boolean>> {
  return Object.fromEntries([...momentary].map((p) => [p, false]));
}
export function clearMomentary(): void {
  momentary.clear();
}

let revision = 0;
const revisionListeners = new Set<() => void>();
export function subscribeDock(l: () => void): () => void {
  revisionListeners.add(l);
  return () => revisionListeners.delete(l);
}
export function dockRevision(): number {
  return revision;
}
function bump(): void {
  revision++;
  for (const l of revisionListeners) l();
}
export function touchDock(): void {
  bump();
}

export function installEdgeChrome(api: DockviewApi, roomOf: (kind: string) => number = () => 0): () => void {
  let queued = false;
  const sync = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      syncEdgeChrome(api);
      fitEdges(api, roomOf);
      bump();
    });
  };
  const watched = new Map<string, { dispose: () => void }>();
  const watch = () => {
    for (const pos of EDGES) {
      const g = api.getEdgeGroup(pos);
      if (!g || watched.has(g.id)) continue;
      watched.set(g.id, g.onDidCollapsedChange(sync));
    }
  };
  watch();
  sync();
  const subs = [
    api.onDidAddPanel(sync),
    api.onDidRemovePanel(sync),
    api.onDidMovePanel(sync),
    api.onDidActivePanelChange(sync),
    api.onDidAddGroup(() => {
      watch();
      sync();
    }),
    api.onDidRemoveGroup((g) => {
      watched.get(g.id)?.dispose();
      watched.delete(g.id);
      sync();
    }),
    api.onDidLayoutFromJSON(() => {
      for (const d of watched.values()) d.dispose();
      watched.clear();
      watch();
      sync();
    }),
  ];
  return () => {
    for (const s of subs) s.dispose();
    for (const d of watched.values()) d.dispose();
    watched.clear();
  };
}
