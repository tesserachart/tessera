import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { DEFAULT_VIEW, layoutsStore, setStageView, type ReturnPlace } from '../../state/layouts.ts';
import { saveLayout, workspaceContext } from '../controller.ts';
import { collapseForNow, restoreForNow } from './open.ts';
import { EDGES, edgeGroup, isEdgePos, placeOf, syncEdgeChrome, touchDock, type EdgePos } from './edges.ts';
import { returnPlaceOf } from './returnPlace.ts';
import { isTextInput } from '../../commands/registry.ts';
import { read } from '../../app/store.ts';

const openedEdges = new WeakMap<DockviewApi, EdgePos[]>();

function centreAnchor(api: DockviewApi, except: string) {
  return api.groups.find((g) => placeOf(g) === 'centre' && g.panels.some((p) => p.id !== except)) ?? null;
}

function toCentre(api: DockviewApi, panel: IDockviewPanel): void {
  const anchor = centreAnchor(api, panel.id);
  if (anchor) panel.api.moveTo({ group: anchor, position: 'right' });
  else panel.api.moveTo({ group: api.addGroup({ direction: 'right' }), position: 'center' });
}

function moveBack(api: DockviewApi, panel: IDockviewPanel, place: ReturnPlace): void {
  const ref = place.referenceGroupId;
  const edge = ref ? EDGES.find((pos) => edgeGroup(api, pos)?.id === ref) : undefined;
  if (edge && isEdgePos(edge)) {
    const group = edgeGroup(api, edge);
    if (!group) return;
    if (!api.isEdgeGroupVisible(edge)) api.setEdgeGroupVisible(edge, true);
    panel.api.moveTo({ group, position: 'center', ...(place.index !== undefined ? { index: place.index } : {}) });
    return;
  }
  const group = ref ? api.groups.find((g) => g.id === ref && g.id !== panel.group.id) : undefined;
  if (!group) return;
  if (place.direction === 'within')
    panel.api.moveTo({ group, position: 'center', ...(place.index !== undefined ? { index: place.index } : {}) });
  else
    panel.api.moveTo({
      group,
      position:
        place.direction === 'above'
          ? 'top'
          : place.direction === 'below'
            ? 'bottom'
            : place.direction === 'left'
              ? 'left'
              : 'right',
    });
}

function quietEdges(api: DockviewApi): void {
  if (openedEdges.has(api)) return;
  const opened = EDGES.filter((pos) => {
    const g = api.getEdgeGroup(pos);
    return !!g && api.isEdgeGroupVisible(pos) && !g.isCollapsed();
  });
  openedEdges.set(api, opened);
  for (const pos of opened) collapseForNow(api, pos);
}

function maximiseIn(api: DockviewApi, panel: IDockviewPanel): void {
  if (!panel.api.isMaximized()) panel.api.maximize();
  quietEdges(api);
}

function release(api: DockviewApi): void {
  for (const pos of openedEdges.get(api) ?? []) restoreForNow(api, pos);
  openedEdges.delete(api);
}

function maximisedPanel(layoutId: string): string | null {
  return (read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW).maximised?.panelId ?? null;
}

export function isMaximised(panelId: string): boolean {
  const ctx = workspaceContext();
  return !!ctx && maximisedPanel(ctx.layoutId) === panelId;
}

function maximiseTile(panelId: string): boolean {
  const ctx = workspaceContext();
  const api = ctx?.api;
  const panel = api?.getPanel(panelId);
  if (!ctx || !api || !panel || ctx.popout) return false;
  if (maximisedPanel(ctx.layoutId) === panelId) return true;
  restoreTile();
  const returnTo = placeOf(panel.group) === 'centre' ? null : returnPlaceOf(api, panel);
  if (returnTo) toCentre(api, panel);
  const moved = api.getPanel(panelId);
  if (!moved) return false;
  maximiseIn(api, moved);
  moved.api.setActive();
  setStageView(ctx.layoutId, { maximised: { panelId, returnTo } });
  syncEdgeChrome(api);
  relayout(api);
  touchDock();
  void saveLayout();
  return true;
}

let restoring = false;

export function restoreTile(): boolean {
  const ctx = workspaceContext();
  const api = ctx?.api;
  if (!ctx || !api || restoring) return false;
  const record = (read(layoutsStore).views[ctx.layoutId] ?? DEFAULT_VIEW).maximised;
  if (!record) return false;
  restoring = true;
  try {
    const panel = api.getPanel(record.panelId);
    if (panel?.api.isMaximized()) panel.api.exitMaximized();
    release(api);
    if (panel && record.returnTo) moveBack(api, panel, record.returnTo);
    setStageView(ctx.layoutId, { maximised: null });
    api.getPanel(record.panelId)?.api.setActive();
  } finally {
    restoring = false;
  }
  syncEdgeChrome(api);
  relayout(api);
  touchDock();
  void saveLayout();
  return true;
}

export function toggleMaximise(panelId: string): void {
  if (isMaximised(panelId)) restoreTile();
  else maximiseTile(panelId);
}

export function reapplyMaximised(api: DockviewApi, layoutId: string): void {
  const id = maximisedPanel(layoutId);
  const panel = id ? api.getPanel(id) : undefined;
  if (!id) return;
  if (!panel || placeOf(panel.group) !== 'centre') {
    setStageView(layoutId, { maximised: null });
    return;
  }
  maximiseIn(api, panel);
}

export function installMaximiseSync(api: DockviewApi, layoutId: string): () => void {
  let live = true;
  const sub = api.onDidMaximizedGroupChange((e) => {
    if (e.isMaximized || restoring) return;
    queueMicrotask(() => {
      if (!live || workspaceContext()?.api !== api) return;
      const id = maximisedPanel(layoutId);
      if (id && !api.getPanel(id)?.api.isMaximized()) restoreTile();
    });
  });
  return () => {
    live = false;
    sub.dispose();
  };
}

function relayout(api: DockviewApi): void {
  requestAnimationFrame(() => {
    const shell = api.groups[0]?.element.closest<HTMLElement>('.dv-shell');
    if (shell && shell.clientWidth > 0) api.layout(shell.clientWidth, shell.clientHeight, true);
  });
}

export function installMaximiseEsc(doc: Document): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && (isTextInput(target) || target.closest('[role="dialog"], [role="menu"], [role="listbox"]'))) return;
    if (restoreTile()) e.preventDefault();
  };
  doc.defaultView?.addEventListener('keydown', onKey);
  return () => doc.defaultView?.removeEventListener('keydown', onKey);
}
