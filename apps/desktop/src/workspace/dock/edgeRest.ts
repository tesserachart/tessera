import type { DockviewApi } from 'dockview-react';
import { useEffect } from 'react';
import { DEFAULT_VIEW, layoutsStore } from '../../state/layouts.ts';
import { edgeGroup, isMomentary } from './edges.ts';
import { collapseEdge, expandEdge } from './motion.ts';
import { isFocusMode, quietly } from './open.ts';
import { RESPONSIVE } from './responsive.ts';
import { patch, read, makeStore, watch } from '../../app/store.ts';

const BUSY_RETRY_MS = 200;

const tilesEmptyStore = makeStore<{ empty: Readonly<Record<string, boolean>> }>({ empty: {} });

export function setTileEmpty(panelId: string, empty: boolean | null): void {
  const was = read(tilesEmptyStore).empty;
  if ((was[panelId] ?? null) === empty) return;
  const next = Object.fromEntries(Object.entries(was).filter(([id]) => id !== panelId));
  patch(tilesEmptyStore, { empty: empty === null ? next : { ...next, [panelId]: empty } });
}

export function tileEmpty(panelId: string): boolean | null {
  return read(tilesEmptyStore).empty[panelId] ?? null;
}

export function useTileEmpty(panelId: string, empty: boolean | null): void {
  useEffect(() => setTileEmpty(panelId, empty), [panelId, empty]);
  useEffect(() => () => setTileEmpty(panelId, null), [panelId]);
}

export interface RestInput {
  chosen: boolean;
  focus: boolean;
  visible: boolean;
  collapsed: boolean;
  momentary: boolean;
  empty: boolean | null;
  short: boolean;
  settled: boolean;
}

export function planRest(i: RestInput): 'rest' | 'open' | null {
  if (i.chosen || i.focus || !i.visible || i.settled || i.empty === null) return null;
  if (i.empty) return i.collapsed ? null : 'rest';
  return i.collapsed && !i.momentary && !i.short ? 'open' : null;
}

export function installEdgeRest(api: DockviewApi, layoutId: string, loadingLayout: () => boolean): () => void {
  let frame = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let shown: string | null = null;
  const evaluate = () => {
    frame = 0;
    if (loadingLayout()) {
      retry ??= setTimeout(() => {
        retry = null;
        schedule();
      }, BUSY_RETRY_MS);
      return;
    }
    const g = api.getEdgeGroup('bottom');
    const group = edgeGroup(api, 'bottom');
    if (!g || !group) return;
    const active = group.activePanel?.id ?? null;
    const empty = active ? tileEmpty(active) : null;
    if (shown !== null && active !== shown) settled = true;
    shown = active;
    const view = read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW;
    const plan = planRest({
      chosen: view.collapsed.bottom !== undefined,
      focus: isFocusMode(),
      visible: api.isEdgeGroupVisible('bottom'),
      collapsed: g.isCollapsed(),
      momentary: isMomentary(api, 'bottom'),
      empty,
      short: api.height > 0 && api.height < RESPONSIVE.bottomBelow,
      settled,
    });
    if (empty !== null) settled = true;
    if (plan === 'rest') quietly(() => collapseEdge(api, 'bottom', 'key'));
    else if (plan === 'open') quietly(() => expandEdge(api, 'bottom', 'pointer'));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(evaluate);
  };
  const offStore = watch(tilesEmptyStore, schedule);
  const offViews = watch(layoutsStore, (s, prev) => {
    if (s.views[layoutId] !== prev.views[layoutId]) schedule();
  });
  const subs = [
    api.onDidActivePanelChange(schedule),
    api.onDidAddPanel(schedule),
    api.onDidRemovePanel(schedule),
    api.onDidMovePanel(schedule),
    api.onDidLayoutFromJSON(() => {
      settled = false;
      shown = null;
      schedule();
    }),
    api.onDidLayoutChange(schedule),
  ];
  schedule();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (retry) clearTimeout(retry);
    offStore();
    offViews();
    for (const s of subs) s.dispose();
  };
}
