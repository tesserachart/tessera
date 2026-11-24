import type { JsonValue } from '@tessera/protocol';
import { EASE, MOTION } from '@tessera/ui';
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import {
  DEFAULT_VIEW,
  layoutsStore,
  setStageView,
  type ClosedTile,
  type ReturnDirection,
  type ReturnPlace,
  type StageView,
} from '../../state/layouts.ts';
import { workspaceStore } from '../../state/workspace.ts';
import { saveLayout, workspaceContext } from '../controller.ts';
import { putOnDesk, type DeskSpot } from '../deskPlace.ts';
import {
  resolveTileKind,
  singletonPanelId,
  tileDefinition,
  UNKNOWN_TILE,
  type TileDefinition,
} from '../tiles/registry.ts';
import { useSyncExternalStore } from 'react';
import {
  dockRevision,
  EDGE_SPEC,
  EDGES,
  edgeGroup,
  edgeOf,
  isEdgePos,
  markMomentary,
  placeOf,
  subscribeDock,
  syncEdgeChrome,
  type DockArea,
  type EdgePos,
  type PanelPlace,
} from './edges.ts';
import { collapseEdge, expandEdge, type Via } from './motion.ts';
import { popoutWindowId } from './popoutIds.ts';
import { returnPlaceOf } from './returnPlace.ts';
import { setTileParams, tileParams } from './tileSettings.ts';
import { offerUndo, snapshotForUndo } from './undo.ts';
import { read } from '../../app/store.ts';
import { closeThisWindow, openTileWindow } from '../../app/host.ts';
import { isMaximised, restoreTile } from './maximise.ts';

export type { Via } from './motion.ts';
interface PanelSnapshot {
  id: string;
  kind: string;
  place: PanelPlace;
  groupId: string;
}

interface EdgeSnapshot {
  collapsed: boolean;
  visible: boolean;
}

export interface DockSnapshot {
  panels: PanelSnapshot[];
  groups: { id: string; place: PanelPlace }[];
  edges: Partial<Record<EdgePos, EdgeSnapshot>>;
  activeChartId: string | null;
}

type RevealSpot =
  | { at: 'edge'; edge: EdgePos; index: number }
  | { at: 'tabs'; groupId: string; index: number }
  | { at: 'split'; groupId: string; direction: Exclude<ReturnDirection, 'within'> }
  | { at: 'beside'; panelId: string | null };

export type RevealPlan =
  | { type: 'none' }
  | {
      type: 'existing';
      panelId: string;
      expand: EdgePos | null;
    }
  | {
      type: 'create';
      panelId: string;
      spot: RevealSpot;
      expand: EdgePos | null;
    };

function spotBack(snap: DockSnapshot, place: ReturnPlace): RevealSpot | null {
  const group = snap.groups.find((g) => g.id === place.referenceGroupId);
  if (!group) return null;
  const tab = (groupId: string) => {
    const n = snap.panels.filter((p) => p.groupId === groupId).length;
    return Math.min(place.index ?? n, n);
  };
  if (place.direction !== 'within')
    return group.place === 'centre' ? { at: 'split', groupId: group.id, direction: place.direction } : null;
  if (isEdgePos(group.place)) return { at: 'edge', edge: group.place, index: tab(EDGE_SPEC[group.place].id) };
  if (group.place === 'centre' || group.place === 'floating')
    return { at: 'tabs', groupId: group.id, index: tab(group.id) };
  return null;
}

function homeSpot(
  snap: DockSnapshot,
  def: Pick<TileDefinition, 'kind' | 'home' | 'order'>,
  orderOf: (kind: string) => number,
): RevealSpot {
  if (def.home === 'centre') {
    const charts = snap.panels.filter((p) => p.kind === 'chart' && p.place === 'centre');
    return { at: 'beside', panelId: charts.find((c) => c.id === snap.activeChartId)?.id ?? charts[0]?.id ?? null };
  }
  const index = snap.panels.filter((p) => p.place === def.home && orderOf(p.kind) <= def.order).length;
  return { at: 'edge', edge: def.home, index };
}

export function planReveal(
  snap: DockSnapshot,
  def: Pick<TileDefinition, 'kind' | 'home' | 'singleton' | 'order'>,
  opts: {
    panelId?: string;
    orderOf?: (kind: string) => number;
    closed?: Pick<ClosedTile, 'panelId' | 'place'> | null;
  } = {},
): RevealPlan {
  const byId = opts.panelId ? snap.panels.find((p) => p.id === opts.panelId) : undefined;
  const byKind = () =>
    snap.panels.find((p) => p.kind === def.kind && p.id === snap.activeChartId) ??
    snap.panels.find((p) => p.kind === def.kind);
  const found = byId ?? (def.singleton || !opts.panelId ? byKind() : undefined);
  const closedEdge = (place: PanelPlace): EdgePos | null => {
    if (place === 'centre' || place === 'floating' || place === 'popout') return null;
    const e = snap.edges[place];
    return e && (e.collapsed || !e.visible) ? place : null;
  };
  if (found) return { type: 'existing', panelId: found.id, expand: closedEdge(found.place) };
  const panelId = opts.panelId ?? opts.closed?.panelId ?? (def.singleton ? def.kind : null);
  if (!panelId) return { type: 'none' };
  const spot =
    (opts.closed ? spotBack(snap, opts.closed.place) : null) ?? homeSpot(snap, def, opts.orderOf ?? (() => 0));
  const edge = spot.at === 'edge' ? snap.edges[spot.edge] : null;
  const expand = spot.at === 'edge' && (!edge || edge.collapsed || !edge.visible) ? spot.edge : null;
  return { type: 'create', panelId, spot, expand };
}

export function panelKind(panel: {
  api: Pick<IDockviewPanel['api'], 'component' | 'getParameters'>;
  params?: unknown;
}): string {
  const c = panel.api.component;
  if (c === UNKNOWN_TILE) {
    const p = (panel.params ?? panel.api.getParameters()) as { originalComponent?: unknown } | undefined;
    return typeof p?.originalComponent === 'string' ? p.originalComponent : c;
  }
  return resolveTileKind(c);
}

function snapshotOf(api: DockviewApi): DockSnapshot {
  const edges: DockSnapshot['edges'] = {};
  for (const pos of EDGES) {
    const g = api.getEdgeGroup(pos);
    if (g) edges[pos] = { collapsed: g.isCollapsed(), visible: api.isEdgeGroupVisible(pos) };
  }
  const active = read(workspaceStore).activeChart;
  return {
    panels: api.panels.map((p) => ({ id: p.id, kind: panelKind(p), place: placeOf(p.group), groupId: p.group.id })),
    groups: api.groups.map((g) => ({ id: g.id, place: placeOf(g) })),
    edges,
    activeChartId: active?.tileId ?? null,
  };
}

let transient = 0;
export function quietly(fn: () => void): void {
  transient++;
  try {
    fn();
  } finally {
    transient--;
  }
}

const userEdgeListeners = new Set<(pos: EdgePos, collapsed: boolean) => void>();
export function onUserEdgeChange(l: (pos: EdgePos, collapsed: boolean) => void): () => void {
  userEdgeListeners.add(l);
  return () => userEdgeListeners.delete(l);
}

export function collapseForNow(api: DockviewApi, pos: EdgePos): void {
  const g = api.getEdgeGroup(pos);
  if (!g || g.isCollapsed()) return;
  quietly(() => collapseEdge(api, pos, 'key'));
  markMomentary(pos, true);
}

export function restoreForNow(api: DockviewApi, pos: EdgePos): void {
  markMomentary(pos, false);
  quietly(() => expandEdge(api, pos, 'key'));
}

export function installCollapseRecorder(api: DockviewApi, layoutId: string): () => void {
  const subs = new Map<string, { dispose: () => void }>();
  const watch = () => {
    for (const pos of EDGES) {
      const g = api.getEdgeGroup(pos);
      if (!g || subs.has(g.id)) continue;
      subs.set(
        g.id,
        g.onDidCollapsedChange(({ isCollapsed }) => {
          if (transient > 0 || focusSnapshot) return;
          // dockview collapses an edge its last tile left
          if (isCollapsed && (edgeGroup(api, pos)?.panels.length ?? 0) === 0) return;
          markMomentary(pos, false);
          for (const l of userEdgeListeners) l(pos, isCollapsed);
          const view = read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW;
          if (view.collapsed[pos] === isCollapsed) return;
          setStageView(layoutId, { collapsed: { ...view.collapsed, [pos]: isCollapsed } });
          queueMicrotask(() => void saveLayout());
        }),
      );
    }
  };
  watch();
  const add = api.onDidAddGroup(watch);
  const load = api.onDidLayoutFromJSON(() => {
    for (const s of subs.values()) s.dispose();
    subs.clear();
    watch();
  });
  return () => {
    add.dispose();
    load.dispose();
    for (const s of subs.values()) s.dispose();
    subs.clear();
  };
}

export interface RevealOptions {
  focus?: boolean;
  tab?: string;
  panelId?: string;
  via?: Via;
}

function focusInside(panelId: string): void {
  requestAnimationFrame(() => {
    const ctx = workspaceContext();
    const panel = ctx?.api.getPanel(panelId);
    const el = panel?.view.content.element;
    const target = el?.querySelector<HTMLElement>('[data-tile-focus]') ?? el?.querySelector<HTMLElement>('.tile');
    if (target) {
      if (!target.hasAttribute('tabindex') && !/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(target.tagName))
        target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  });
}

function stageView(layoutId: string): StageView {
  return read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW;
}

function recordOf(def: Pick<TileDefinition, 'kind' | 'singleton'>, panelId: string | undefined) {
  return (c: ClosedTile) => (def.singleton ? c.kind === def.kind : c.panelId === panelId);
}

function closedWithout(layoutId: string, def: TileDefinition, panelId: string): ClosedTile[] {
  const own = recordOf(def, panelId);
  return stageView(layoutId).closed.filter((c) => !own(c));
}

function rememberClosed(layoutId: string, api: DockviewApi, panel: IDockviewPanel, def: TileDefinition): void {
  if (def.kind === 'chart') return;
  const place = returnPlaceOf(api, panel);
  if (!place) return;
  const params = tileParams<Record<string, JsonValue>>(panel.api) as Record<string, JsonValue>;
  const record: ClosedTile = {
    panelId: panel.id,
    kind: def.kind,
    place,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
  setStageView(layoutId, { closed: [...closedWithout(layoutId, def, panel.id), record] });
}

function forgetClosed(layoutId: string, def: TileDefinition, panelId: string): void {
  const rest = closedWithout(layoutId, def, panelId);
  if (rest.length !== stageView(layoutId).closed.length) setStageView(layoutId, { closed: rest });
}

export function reservedPanelIds(layoutId: string): ReadonlySet<string> {
  const view = stageView(layoutId);
  return new Set([...view.popouts.map((p) => p.panelId), ...view.closed.map((c) => c.panelId)]);
}

export function forgetClosedTile(panelId: string): void {
  const ctx = workspaceContext();
  if (!ctx) return;
  const closed = stageView(ctx.layoutId).closed;
  setStageView(ctx.layoutId, { closed: closed.filter((c) => c.panelId !== panelId) });
  void saveLayout();
}

function deskSpot(spot: RevealSpot): DeskSpot {
  switch (spot.at) {
    case 'edge':
      return spot;
    case 'tabs':
      return { at: 'tabs', group: spot.groupId, index: spot.index };
    case 'split':
      return { at: 'split', group: spot.groupId, side: spot.direction };
    case 'beside':
      return { at: 'beside', panel: spot.panelId, side: 'right' };
  }
}

function addTile(
  api: DockviewApi,
  def: TileDefinition,
  plan: Extract<RevealPlan, { type: 'create' }>,
  params: Record<string, unknown>,
): boolean {
  const panel = {
    id: plan.panelId,
    component: def.kind,
    title: def.title,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
  return putOnDesk(api, panel, deskSpot(plan.spot)) !== null;
}

export function revealTile(kind: string, opts: RevealOptions = {}): string | null {
  const ctx = workspaceContext();
  const def = tileDefinition(kind);
  if (!ctx || !def) return null;
  const view = stageView(ctx.layoutId);
  const away = view.popouts.find(
    (p) => (opts.panelId ? p.panelId === opts.panelId : p.kind === def.kind) && !ctx.popout,
  );
  if (away) {
    if (ctx.tileWindows)
      void openTileWindow({
        kind: away.kind,
        id: popoutWindowId(ctx.layoutId, away.panelId),
        title: def.title,
      }).catch(() => undefined);
    return away.panelId;
  }
  const api = ctx.api;
  const via = opts.via ?? 'pointer';
  const orderOf = (k: string) => tileDefinition(k)?.order ?? 0;
  const panelId = opts.panelId ?? (def.singleton ? (singletonPanelId(kind) ?? kind) : undefined);
  const closed = view.closed.findLast(recordOf(def, panelId)) ?? null;
  const plan = planReveal(snapshotOf(api), def, { orderOf, closed, ...(panelId ? { panelId } : {}) });
  if (plan.type === 'none') return null;
  const params = { ...(closed?.params ?? {}), ...(opts.tab ? { tab: opts.tab } : {}) };
  if (plan.type === 'create' && !addTile(api, def, plan, params)) return null;
  const panel = api.getPanel(plan.panelId);
  if (!panel) return null;
  forgetClosed(ctx.layoutId, def, panel.id);
  if (plan.type === 'existing' && opts.tab) setTileParams<{ tab: string }>(panel.api, { tab: opts.tab });
  if (plan.expand) expandEdge(api, plan.expand, via);
  panel.api.setActive();
  syncEdgeChrome(api);
  if (opts.focus) focusInside(panel.id);
  return panel.id;
}

export function paramsMatch(
  have: Readonly<Record<string, unknown>>,
  want?: Readonly<Record<string, unknown>>,
): boolean {
  if (!want) return true;
  return Object.entries(want).every(([k, v]) => (have[k] ?? null) === (v ?? null));
}

function chartFor(api: DockviewApi, layoutId: string, instrument: unknown): string | null {
  const shown = (id: string | null | undefined) => (id && api.getPanel(id) ? id : null);
  const active = shown(read(workspaceStore).activeChart?.tileId);
  const charts = read(layoutsStore).layouts[layoutId]?.charts ?? {};
  if (typeof instrument !== 'string' || (active && charts[active]?.instrument === instrument)) return active;
  return shown(Object.values(charts).find((c) => c.instrument === instrument && shown(c.tileId))?.tileId) ?? active;
}

export function openTile(
  kind: string,
  opts: { params?: Readonly<Record<string, unknown>>; via?: Via; focus?: boolean } = {},
): string | null {
  const ctx = workspaceContext();
  const def = tileDefinition(kind);
  if (!ctx || !def) return null;
  const via = opts.via ?? 'pointer';
  if (def.singleton || !def.add) return revealTile(kind, { via, ...(opts.focus ? { focus: true } : {}) });
  const api = ctx.api;
  const same = api.panels.find(
    (p) => panelKind(p) === def.kind && paramsMatch(tileParams<Record<string, unknown>>(p.api), opts.params),
  );
  if (same) return revealTile(def.kind, { panelId: same.id, via, ...(opts.focus ? { focus: true } : {}) });
  const closed = stageView(ctx.layoutId).closed.findLast(
    (c) => c.kind === def.kind && !api.getPanel(c.panelId) && paramsMatch(c.params ?? {}, opts.params),
  );
  if (closed) return revealTile(def.kind, { panelId: closed.panelId, via, ...(opts.focus ? { focus: true } : {}) });
  const beside = chartFor(api, ctx.layoutId, opts.params?.instrument);
  const id = def.add(api, {
    beside,
    taken: reservedPanelIds(ctx.layoutId),
    ...(opts.params ? { params: opts.params } : {}),
  });
  const panel = id ? api.getPanel(id) : undefined;
  if (!id || !panel) return null;
  panel.api.setActive();
  syncEdgeChrome(api);
  if (opts.focus) focusInside(id);
  return id;
}

export function isTileVisible(panelId: string): boolean {
  const ctx = workspaceContext();
  const api = ctx?.api;
  const panel = api?.getPanel(panelId);
  if (!ctx || !api || !panel) return false;
  if (panel.group.activePanel?.id !== panelId) return false;
  const edge = edgeOf(panel.group);
  return !(edge && (api.getEdgeGroup(edge)?.isCollapsed() ?? false));
}

export function useTileVisible(kind: string): boolean {
  useSyncExternalStore(subscribeDock, dockRevision);
  const id = singletonPanelId(kind) ?? kind;
  return isTileVisible(id);
}

export function closeTile(panelId: string): boolean {
  const ctx = workspaceContext();
  const api = ctx?.api;
  const panel = api?.getPanel(panelId);
  if (!ctx || !api || !panel) return false;
  if (ctx.popout && ctx.windowPanel === panelId) {
    closeThisWindow();
    return true;
  }
  if (isMaximised(panelId)) restoreTile();
  const before = snapshotForUndo();
  const def = tileDefinition(panelKind(panel));
  const name = panel.api.title ?? def?.title ?? 'the panel';
  if (def && !ctx.popout) rememberClosed(ctx.layoutId, api, panel, def);
  panel.api.close();
  offerUndo(`Closed ${name}`, before);
  syncEdgeChrome(api);
  return true;
}

export function toggleEdge(pos: EdgePos, via: Via): void {
  const api = workspaceContext()?.api;
  const g = api?.getEdgeGroup(pos);
  if (!api || !g) return;
  if (!api.isEdgeGroupVisible(pos)) return;
  if (g.isCollapsed()) expandEdge(api, pos, via);
  else collapseEdge(api, pos, via);
}

function centreAnchor(api: DockviewApi, except: string): DockviewGroupPanel | null {
  const active = read(workspaceStore).activeChart?.tileId;
  const chart = active ? api.getPanel(active) : null;
  if (chart && chart.id !== except && placeOf(chart.group) === 'centre') return chart.group;
  return api.groups.find((g) => placeOf(g) === 'centre' && !g.panels.every((p) => p.id === except)) ?? null;
}

export function moveTile(panelId: string, to: DockArea, via: Via = 'pointer'): void {
  const ctx = workspaceContext();
  const api = ctx?.api;
  const panel = api?.getPanel(panelId);
  if (!ctx || !api || !panel) return;
  const before = snapshotForUndo();
  const from = placeOf(panel.group);
  if (to === 'centre') {
    const anchor = centreAnchor(api, panelId);
    if (anchor) panel.api.moveTo({ group: anchor, position: 'right' });
    else panel.api.moveTo({ group: api.addGroup({ direction: 'right' }), position: 'center' });
  } else {
    const group = edgeGroup(api, to);
    if (!group) return;
    if (!api.isEdgeGroupVisible(to)) api.setEdgeGroupVisible(to, true);
    if (from !== to) panel.api.moveTo({ group, position: 'center' });
    expandEdge(api, to, via);
  }
  api.getPanel(panelId)?.api.setActive();
  syncEdgeChrome(api);
  if (from !== to) offerUndo(`Moved ${panel.api.title ?? 'the tile'} to ${AREA_WORDS[to]}`, before);
}

const AREA_WORDS: Record<DockArea, string> = {
  left: 'the left side',
  right: 'the right side',
  bottom: 'the bottom',
  centre: 'the centre',
};

export function floatTile(panelId: string): void {
  const api = workspaceContext()?.api;
  const panel = api?.getPanel(panelId);
  if (!api || !panel) return;
  const r = panel.group.element.getBoundingClientRect();
  const host = panel.group.element.closest('.dv-shell')?.getBoundingClientRect() ?? r;
  const width = Math.min(640, Math.max(320, host.width - 48));
  const height = Math.min(480, Math.max(240, host.height - 48));
  const cx = r.left + r.width / 2 - host.left;
  const cy = r.top + r.height / 2 - host.top;
  const x = Math.round(Math.min(Math.max(0, cx - width / 2), Math.max(0, host.width - width)));
  const y = Math.round(Math.min(Math.max(0, cy - height / 2), Math.max(0, host.height - height)));
  const before = snapshotForUndo();
  api.addFloatingGroup(panel, { x, y, width, height });
  syncEdgeChrome(api);
  const el = api.getPanel(panelId)?.group.element.closest<HTMLElement>('.dv-resize-container');
  if (el && typeof el.animate === 'function') {
    const still =
      el.ownerDocument.documentElement.dataset.motion === 'reduced' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.animate(
      [
        { opacity: 0, transform: still ? 'none' : 'scale(0.98)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: MOTION.menuMs, easing: EASE.outStrong },
    );
  }
  offerUndo(`Floated ${panel.api.title ?? 'the tile'}`, before);
}

let focusSnapshot: Partial<Record<EdgePos, boolean>> | null = null;

export function isFocusMode(): boolean {
  return focusSnapshot !== null;
}

export function toggleFocusMode(): void {
  const api = workspaceContext()?.api;
  if (!api) return;
  if (focusSnapshot) {
    const back = focusSnapshot;
    focusSnapshot = null;
    for (const pos of EDGES) if (back[pos] === false) restoreForNow(api, pos);
    return;
  }
  const snap: Partial<Record<EdgePos, boolean>> = {};
  for (const pos of EDGES) {
    const g = api.getEdgeGroup(pos);
    if (g) snap[pos] = g.isCollapsed();
  }
  focusSnapshot = snap;
  for (const pos of EDGES) if (snap[pos] === false) collapseForNow(api, pos);
}

export function resetFocusMode(): void {
  focusSnapshot = null;
}

export function cycleTab(dir: 1 | -1): void {
  const api = workspaceContext()?.api;
  const group = api?.activeGroup;
  if (!api || !group || group.panels.length < 2) return;
  const i = group.panels.findIndex((p) => p.id === group.activePanel?.id);
  const next = group.panels[(i + dir + group.panels.length) % group.panels.length];
  if (!next) return;
  next.api.setActive();
  focusInside(next.id);
}

/** dockview's keyboard navigation ships only in the paid dockview-enterprise. */
export function cycleGroup(dir: 1 | -1): void {
  const api = workspaceContext()?.api;
  if (!api) return;
  const shown = api.groups
    .filter((g) => {
      const edge = edgeOf(g);
      if (edge && (api.getEdgeGroup(edge)?.isCollapsed() || !api.isEdgeGroupVisible(edge))) return false;
      return g.activePanel !== undefined && g.element.isConnected;
    })
    .map((g) => ({ g, r: g.element.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0)
    .sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top)
    .map(({ g }) => g);
  if (shown.length === 0) return;
  const i = shown.findIndex((g) => g.id === api.activeGroup?.id);
  const next = shown[(i + dir + shown.length) % shown.length];
  const panel = next?.activePanel;
  if (!panel) return;
  panel.api.setActive();
  focusInside(panel.id);
}

export function closeActiveTab(): boolean {
  const panel = workspaceContext()?.api.activePanel;
  return panel ? closeTile(panel.id) : false;
}
