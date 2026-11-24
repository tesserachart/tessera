import type { ScreenArea } from '@tessera/bridge';
import type { JsonValue } from '@tessera/protocol';
import type { DockviewApi } from 'dockview-react';
import { DEFAULT_VIEW, type PopoutRecord, layoutsStore, setLayoutCharts, setStageView } from '../../state/layouts.ts';
import { saveLayout, workspaceContext } from '../controller.ts';
import { chartTile, dropOnDesk, firstCentreChart, putOnDesk, type RailTarget } from '../deskPlace.ts';
import { tileDefinition, UNKNOWN_TILE } from '../tiles/registry.ts';
import { syncEdgeChrome } from './edges.ts';
import { isMaximised, restoreTile } from './maximise.ts';
import { panelKind, revealTile } from './open.ts';
import { popoutWindowId } from './popoutIds.ts';
import { returnPlaceOf } from './returnPlace.ts';
import { deskToasts, sayFailed } from './deskToasts.ts';
import { UNDO_MS } from './undo.ts';

import { tileParams } from './tileSettings.ts';
import { read, watch as watchStore } from '../../app/store.ts';
import { workspaceStore } from '../../state/workspace.ts';
import {
  closeTileWindow,
  hostScreens,
  onTileWindowClosed,
  openTileWindow,
  thisWindowBounds,
  tileWindowBounds,
} from '../../app/host.ts';

export const POPOUT_CHANNEL = 'tessera-popouts';
export const PANEL_DRAG_TYPE = 'application/x-tessera-panel';

export type PopoutMessage =
  | { type: 'params'; layoutId: string; panelId: string; params: Record<string, JsonValue> }
  | { type: 'dock'; layoutId: string; panelId: string }
  | { type: 'active'; layoutId: string; tileId: string | null }
  | { type: 'ask-active'; layoutId: string };

export interface PanelDrag {
  layoutId: string;
  panelId: string;
}

const WINDOW_NOT_CLOSED = 'A popped-out window could not close';

function closeWindow(id: string): void {
  void closeTileWindow(id).catch((err: unknown) => sayFailed(WINDOW_NOT_CLOSED, err));
}

type Bounds = NonNullable<PopoutRecord['bounds']>;

export function popoutBounds(app: Bounds, screen: ScreenArea | null): Bounds {
  return {
    x: app.x,
    y: app.y,
    width: screen ? Math.min(app.width, screen.width) : app.width,
    height: screen ? Math.min(app.height, screen.height) : app.height,
  };
}

function overlap(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function screenOf(bounds: Bounds, screens: readonly ScreenArea[] | null): ScreenArea | null {
  let best: { s: ScreenArea; area: number } | null = null;
  for (const s of screens ?? []) {
    const area = overlap(bounds, s);
    if (area > 0 && (!best || area > best.area)) best = { s, area };
  }
  return best?.s ?? null;
}

export function standsOnScreens(record: PopoutRecord, screens: readonly ScreenArea[] | null): boolean {
  if (!screens || !record.bounds) return true;
  const on = screenOf(record.bounds, screens);
  return !!on && (record.monitor === null || screens.some((s) => s.name === record.monitor));
}

function view(layoutId: string) {
  return read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW;
}

function setPopouts(layoutId: string, popouts: PopoutRecord[]): void {
  setStageView(layoutId, { popouts });
}

function takeRecord(layoutId: string, panelId: string): PopoutRecord | null {
  const popouts = view(layoutId).popouts;
  const record = popouts.find((p) => p.panelId === panelId) ?? null;
  if (record)
    setPopouts(
      layoutId,
      popouts.filter((p) => p.panelId !== panelId),
    );
  return record;
}

export function poppedPanel(layoutId: string, kind: string): PopoutRecord | null {
  return view(layoutId).popouts.find((p) => p.kind === kind) ?? null;
}

const watchers = new Map<string, () => void>();
let boundsTimer: ReturnType<typeof setInterval> | null = null;

function unwatch(id: string): void {
  watchers.get(id)?.();
  watchers.delete(id);
}

function windowSpec(layoutId: string, record: PopoutRecord) {
  const chart = record.kind === 'chart' ? read(layoutsStore).layouts[layoutId]?.charts[record.panelId] : undefined;
  return {
    kind: record.kind,
    id: popoutWindowId(layoutId, record.panelId),
    title: chart?.title ?? tileDefinition(record.kind)?.title ?? record.kind,
    params: {
      ...(record.params ?? {}),
      layoutId,
      panelId: record.panelId,
      ...(record.kind === 'chart' ? { tileId: record.panelId } : {}),
    },
    ...(record.bounds ?? {}),
  };
}

export async function popOutTile(panelId: string): Promise<boolean> {
  const ctx = workspaceContext();
  const api = ctx?.api;
  const panel = api?.getPanel(panelId);
  if (!ctx?.tileWindows || !api || !panel || ctx.popout) return false;
  const kind = panelKind(panel);
  if (!tileDefinition(kind) || kind === UNKNOWN_TILE) return false;
  if (isMaximised(panelId)) restoreTile();
  const docked = api.getPanel(panelId) ?? panel;
  const [app, screens] = await Promise.all([thisWindowBounds(), hostScreens().catch(() => null)]);
  const bounds = app ? popoutBounds(app, screenOf(app, screens)) : null;
  const params = tileParams<Record<string, JsonValue>>(docked.api) as Record<string, JsonValue>;
  const record: PopoutRecord = {
    panelId,
    kind,
    bounds,
    monitor: bounds ? (screenOf(bounds, screens)?.name ?? null) : null,
    returnTo: returnPlaceOf(api, docked),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
  const opened = await openTileWindow(windowSpec(ctx.layoutId, record));
  if (!opened) return false;
  if (workspaceContext() !== ctx) {
    closeWindow(popoutWindowId(ctx.layoutId, panelId));
    return false;
  }
  setPopouts(ctx.layoutId, [...view(ctx.layoutId).popouts.filter((p) => p.panelId !== panelId), record]);
  api.getPanel(panelId)?.api.close();
  syncEdgeChrome(api);
  watchWindow(ctx.layoutId, record);
  ctx.allowDockSaves();
  void saveLayout();
  return true;
}

function placeBack(api: DockviewApi, layoutId: string, record: PopoutRecord, target?: RailTarget): void {
  if (record.kind === 'chart') {
    const chart = read(layoutsStore).layouts[layoutId]?.charts[record.panelId];
    if (!chart || api.getPanel(record.panelId)) return;
    const own = { ...(record.params ?? {}), layoutId, tileId: record.panelId };
    const tile = { ...chartTile(layoutId, chart), params: own };
    if (target) {
      dropOnDesk(api, target, tile);
      return;
    }
    const back = record.returnTo;
    const ref = back && api.groups.some((g) => g.id === back.referenceGroupId) ? back.referenceGroupId : null;
    putOnDesk(
      api,
      tile,
      !ref || !back
        ? { at: 'beside', panel: firstCentreChart(api)?.id ?? null, side: 'right' }
        : back.direction === 'within'
          ? { at: 'tabs', group: ref }
          : { at: 'split', group: ref, side: back.direction },
    );
    return;
  }
  const def = tileDefinition(record.kind);
  if (!def) return;
  if (target) {
    dropOnDesk(api, target, {
      id: record.panelId,
      component: def.kind,
      title: def.title,
      ...(record.params ? { params: record.params } : {}),
    });
    api.getPanel(record.panelId)?.api.setActive();
    return;
  }
  const { returnTo, params } = record;
  if (returnTo)
    setStageView(layoutId, {
      closed: [
        ...view(layoutId).closed.filter((c) => c.panelId !== record.panelId),
        { panelId: record.panelId, kind: record.kind, place: returnTo, ...(params ? { params } : {}) },
      ],
    });
  revealTile(record.kind, { via: 'key', panelId: record.panelId });
}

export function dockBack(layoutId: string, panelId: string, target?: RailTarget): boolean {
  const ctx = workspaceContext();
  if (!ctx || ctx.popout || ctx.layoutId !== layoutId) return false;
  const id = popoutWindowId(layoutId, panelId);
  const record = takeRecord(layoutId, panelId);
  unwatch(id);
  closeWindow(id);
  if (!record) return false;
  placeBack(ctx.api, layoutId, record, target);
  syncEdgeChrome(ctx.api);
  void saveLayout();
  return true;
}

function offerChartBack(layoutId: string, record: PopoutRecord): void {
  const chart = read(layoutsStore).layouts[layoutId]?.charts[record.panelId];
  if (!chart) return;
  deskToasts.push({
    key: 'dock-undo',
    title: `Closed ${chart.title}`,
    ms: UNDO_MS,
    action: {
      label: 'Undo',
      run: () => {
        const ctx = workspaceContext();
        const layout = read(layoutsStore).layouts[layoutId];
        if (ctx?.layoutId !== layoutId || !layout || ctx.api.getPanel(record.panelId)) return;
        setLayoutCharts(layoutId, { ...layout.charts, [record.panelId]: chart });
        placeBack(ctx.api, layoutId, record);
        syncEdgeChrome(ctx.api);
        void saveLayout();
      },
    },
  });
}

function sendToLibrary(layoutId: string, panelId: string): void {
  unwatch(popoutWindowId(layoutId, panelId));
  const record = takeRecord(layoutId, panelId);
  if (!record) return;
  if (record.kind === 'chart' && workspaceContext()?.layoutId === layoutId) offerChartBack(layoutId, record);
  if (record.kind !== 'chart' && record.returnTo)
    setStageView(layoutId, {
      closed: [
        ...view(layoutId).closed.filter((c) => c.panelId !== panelId),
        {
          panelId,
          kind: record.kind,
          place: record.returnTo,
          ...(record.params ? { params: record.params } : {}),
        },
      ],
    });
  if (workspaceContext()?.layoutId === layoutId) void saveLayout();
}

function post(msg: PopoutMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(POPOUT_CHANNEL);
  channel.postMessage(msg);
  channel.close();
}

export function requestDockBack(panelId: string): void {
  const ctx = workspaceContext();
  if (ctx?.popout) post({ type: 'dock', layoutId: ctx.layoutId, panelId });
}

export function readPanelDrag(data: Pick<DataTransfer, 'getData'>): PanelDrag | null {
  try {
    const v = JSON.parse(data.getData(PANEL_DRAG_TYPE)) as Partial<PanelDrag>;
    return typeof v.layoutId === 'string' && typeof v.panelId === 'string'
      ? { layoutId: v.layoutId, panelId: v.panelId }
      : null;
  } catch {
    return null;
  }
}

function watchWindow(layoutId: string, record: PopoutRecord): void {
  const ctx = workspaceContext();
  const id = popoutWindowId(layoutId, record.panelId);
  unwatch(id);
  if (!ctx?.tileWindows) return;
  watchers.set(
    id,
    onTileWindowClosed(id, () => sendToLibrary(layoutId, record.panelId)),
  );
  ensureBoundsWatch();
}

function ensureBoundsWatch(): void {
  if (boundsTimer) return;
  boundsTimer = setInterval(() => {
    const ctx = workspaceContext();
    if (!ctx?.tileWindows || ctx.popout || watchers.size === 0) return;
    const layoutId = ctx.layoutId;
    void Promise.all([
      hostScreens().catch(() => null),
      Promise.all(
        view(layoutId).popouts.map(async (p) => ({
          p,
          b: await tileWindowBounds(popoutWindowId(layoutId, p.panelId)),
        })),
      ),
    ]).then(([screens, bounds]) => {
      if (workspaceContext()?.layoutId !== layoutId) return;
      const before = view(layoutId).popouts;
      const next = before.map((p) => {
        const b = bounds.find((r) => r.p.panelId === p.panelId)?.b;
        if (!b) return p;
        const same = (k: keyof Bounds) => !!p.bounds && Math.abs(b[k] - p.bounds[k]) < 2;
        const monitor = screenOf(b, screens)?.name ?? p.monitor;
        if (same('x') && same('y') && same('width') && same('height') && monitor === p.monitor) return p;
        return { ...p, bounds: b, monitor };
      });
      if (next.some((p, i) => p !== before[i])) {
        setPopouts(layoutId, next);
        void saveLayout();
      }
    });
  }, 3000);
}

export function resumePopouts(layoutId: string): (closeWindows: boolean) => void {
  const ctx = workspaceContext();
  let live = true;
  if (ctx?.tileWindows && !ctx.popout) {
    void hostScreens()
      .catch(() => null)
      .then((screens) => {
        if (!live || workspaceContext()?.layoutId !== layoutId) return;
        for (const record of view(layoutId).popouts) {
          const id = popoutWindowId(layoutId, record.panelId);
          if (watchers.has(id)) continue;
          if (record.kind === 'chart' && !read(layoutsStore).layouts[layoutId]?.charts[record.panelId]) {
            takeRecord(layoutId, record.panelId);
            continue;
          }
          if (!standsOnScreens(record, screens)) {
            dockBack(layoutId, record.panelId);
            continue;
          }
          void openTileWindow(windowSpec(layoutId, record)).then((ok) => {
            if (!live) {
              if (ok && !watchers.has(id)) closeWindow(id);
              return;
            }
            if (ok) watchWindow(layoutId, record);
            else dockBack(layoutId, record.panelId);
          });
        }
      });
  }
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(POPOUT_CHANNEL);
  const tellActive = () => {
    const active = read(workspaceStore).activeChart;
    const msg: PopoutMessage = {
      type: 'active',
      layoutId,
      tileId: active?.layoutId === layoutId ? active.tileId : null,
    };
    channel?.postMessage(msg);
  };
  const offActive = watchStore(workspaceStore, (s, was) => {
    if (s.activeChart !== was.activeChart && s.activeChart?.layoutId === layoutId) tellActive();
  });
  if (channel) {
    channel.onmessage = (e: MessageEvent<PopoutMessage>) => {
      const m = e.data;
      if (m.layoutId !== layoutId) return;
      if (m.type === 'ask-active') {
        tellActive();
        return;
      }
      if (m.type === 'active') return;
      if (m.type === 'dock') {
        dockBack(layoutId, m.panelId);
        return;
      }
      const popouts = view(layoutId).popouts;
      if (!popouts.some((p) => p.panelId === m.panelId)) return;
      setPopouts(
        layoutId,
        popouts.map((p) => (p.panelId === m.panelId ? { ...p, params: m.params } : p)),
      );
      void saveLayout();
    };
  }
  return (closeWindows) => {
    offActive();
    channel?.close();
    if (!closeWindows) return;
    live = false;
    for (const record of view(layoutId).popouts) {
      const id = popoutWindowId(layoutId, record.panelId);
      if (!watchers.has(id)) continue;
      unwatch(id);
      closeWindow(id);
    }
  };
}

function panelTransfer(e: DragEvent | PointerEvent): DataTransfer | null {
  const data = 'dataTransfer' in e ? e.dataTransfer : null;
  return data?.types.includes(PANEL_DRAG_TYPE) ? data : null;
}

export function installPanelDrop(api: DockviewApi, layoutId: string): () => void {
  const over = api.onUnhandledDragOver((ev) => {
    if (panelTransfer(ev.nativeEvent)) ev.accept();
  });
  const drop = api.onDidDrop((ev) => {
    const data = panelTransfer(ev.nativeEvent);
    const dragged = data ? readPanelDrag(data) : null;
    if (dragged?.layoutId !== layoutId) return;
    const group = ev.group ?? null;
    const at = group && ev.panel ? group.panels.indexOf(ev.panel) : -1;
    dockBack(
      layoutId,
      dragged.panelId,
      group
        ? { group, position: ev.position, ...(at >= 0 ? { index: at } : {}) }
        : { group: null, position: ev.position },
    );
  });
  return () => {
    over.dispose();
    drop.dispose();
  };
}

export function resetPopoutWatches(): void {
  for (const off of watchers.values()) off();
  watchers.clear();
  if (boundsTimer) clearInterval(boundsTimer);
  boundsTimer = null;
}
