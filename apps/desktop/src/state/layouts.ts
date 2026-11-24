import type { ChartLayer, ChartState, ChartTemplate, JsonValue, Layout } from '@tessera/protocol';
import { createEchoGuard } from '../app/echoGuard.ts';
import { patch, read, makeStore, type Store, useStore } from '../app/store.ts';

export const LAYOUT_PRESETS = ['1', '2h', '2v', '3', '4', '6'] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

export const CHART_TYPES = ['candles', 'bars', 'line'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const SERIES_TYPES = [...CHART_TYPES, 'none'] as const;
export type SeriesType = (typeof SERIES_TYPES)[number];
export const CHART_TYPE_WORD: Record<SeriesType, string> = {
  candles: 'Candles',
  bars: 'Bars',
  line: 'Line',
  none: 'No price',
};

export const STORY_IDS = ['trade', 'scalp', 'analyse', 'review'] as const;
export type StoryId = (typeof STORY_IDS)[number];

type ViewEdge = 'left' | 'right' | 'bottom';

const RETURN_DIRECTIONS = ['left', 'right', 'above', 'below', 'within'] as const;
export type ReturnDirection = (typeof RETURN_DIRECTIONS)[number];

export interface ReturnPlace {
  referenceGroupId: string | null;
  direction: ReturnDirection;
  index?: number;
}

export interface PopoutRecord {
  panelId: string;
  kind: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  monitor: string | null;
  returnTo: ReturnPlace | null;
  params?: Record<string, JsonValue>;
}

interface MaximisedTile {
  panelId: string;
  returnTo: ReturnPlace | null;
}

export interface ClosedTile {
  panelId: string;
  kind: string;
  place: ReturnPlace;
  params?: Record<string, JsonValue>;
}

export interface StageView {
  v: number;
  preset: LayoutPreset | null;
  syncInterval: boolean;
  chartTypes: Record<string, ChartType>;
  collapsed: Partial<Record<ViewEdge, boolean>>;
  popouts: PopoutRecord[];
  closed: ClosedTile[];
  maximised: MaximisedTile | null;
  story: StoryId | null;
}

export const DOCK_VIEW_KEY = 'tessera';

export const DOCK_VERSION = 5;

export const DEFAULT_VIEW: StageView = {
  v: 0,
  preset: null,
  syncInterval: false,
  chartTypes: {},
  collapsed: {},
  popouts: [],
  closed: [],
  maximised: null,
  story: null,
};

function readReturnPlace(v: unknown): ReturnPlace | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (!(RETURN_DIRECTIONS as readonly unknown[]).includes(t.direction)) return null;
  return {
    referenceGroupId: typeof t.referenceGroupId === 'string' ? t.referenceGroupId : null,
    direction: t.direction as ReturnDirection,
    ...(typeof t.index === 'number' && Number.isInteger(t.index) && t.index >= 0 ? { index: t.index } : {}),
  };
}

function readTileRecords<T>(
  v: unknown,
  parse: (
    r: Record<string, unknown>,
    own: { panelId: string; kind: string; params?: Record<string, JsonValue> },
  ) => T | null,
): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (typeof r.panelId !== 'string' || typeof r.kind !== 'string') continue;
    const params =
      r.params && typeof r.params === 'object' && !Array.isArray(r.params)
        ? { params: r.params as Record<string, JsonValue> }
        : {};
    const record = parse(r, { panelId: r.panelId, kind: r.kind, ...params });
    if (record) out.push(record);
  }
  return out;
}

function readPopouts(v: unknown): PopoutRecord[] {
  return readTileRecords(v, (r, own) => {
    const b = r.bounds as Record<string, unknown> | null | undefined;
    const bounds =
      b && ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number')
        ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
        : null;
    return {
      ...own,
      bounds,
      monitor: typeof r.monitor === 'string' ? r.monitor : null,
      returnTo: readReturnPlace(r.returnTo),
    };
  });
}

function readClosed(v: unknown): ClosedTile[] {
  return readTileRecords(v, (r, own) => {
    const place = readReturnPlace(r.place);
    return place ? { ...own, place } : null;
  });
}

function readMaximised(v: unknown): MaximisedTile | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return typeof r.panelId === 'string' ? { panelId: r.panelId, returnTo: readReturnPlace(r.returnTo) } : null;
}

export function viewOfDock(dock: JsonValue | undefined): StageView {
  const raw =
    dock && typeof dock === 'object' && !Array.isArray(dock) ? (dock as Record<string, unknown>)[DOCK_VIEW_KEY] : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_VIEW;
  const v = raw as Record<string, unknown>;
  const types: Record<string, ChartType> = {};
  if (v.chartTypes && typeof v.chartTypes === 'object' && !Array.isArray(v.chartTypes)) {
    for (const [k, t] of Object.entries(v.chartTypes as Record<string, unknown>)) {
      if ((CHART_TYPES as readonly unknown[]).includes(t)) types[k] = t as ChartType;
    }
  }
  const collapsed: Partial<Record<ViewEdge, boolean>> = {};
  if (v.collapsed && typeof v.collapsed === 'object' && !Array.isArray(v.collapsed)) {
    for (const e of ['left', 'right', 'bottom'] as const) {
      const c = (v.collapsed as Record<string, unknown>)[e];
      if (typeof c === 'boolean') collapsed[e] = c;
    }
  }
  return {
    v: typeof v.v === 'number' && Number.isInteger(v.v) && v.v > 0 ? v.v : 0,
    preset: (LAYOUT_PRESETS as readonly unknown[]).includes(v.preset) ? (v.preset as LayoutPreset) : null,
    syncInterval: v.syncInterval === true,
    chartTypes: types,
    collapsed,
    popouts: readPopouts(v.popouts),
    closed: readClosed(v.closed),
    maximised: readMaximised(v.maximised),
    story: (STORY_IDS as readonly unknown[]).includes(v.story) ? (v.story as StoryId) : null,
  };
}

export function dockTreeOf(dock: JsonValue | undefined): JsonValue | undefined {
  if (!dock || typeof dock !== 'object' || Array.isArray(dock) || !(DOCK_VIEW_KEY in dock)) return dock;
  const { [DOCK_VIEW_KEY]: _view, ...tree } = dock;
  return tree;
}

export interface LayoutsState {
  layouts: Record<string, Layout>;
  chartToolRevision: Record<string, number>;
  views: Record<string, StageView>;
}

const EMPTY_LAYOUTS: LayoutsState = { layouts: {}, chartToolRevision: {}, views: {} };

function makeLayoutsStore(): Store<LayoutsState> {
  return makeStore(EMPTY_LAYOUTS);
}

export const layoutsStore = makeLayoutsStore();

export const layoutGuard = createEchoGuard();
export const layoutKeys = {
  chart: (layoutId: string, tileId: string) => `${layoutId}/chart/${tileId}`,
  view: (layoutId: string) => `${layoutId}/view`,
  active: (layoutId: string) => `${layoutId}/active`,
  trade: (layoutId: string) => `${layoutId}/trade`,
};

const guardedTiles = new Map<string, Set<string>>();

function guardedChartIds(layoutId: string): ReadonlySet<string> {
  return guardedTiles.get(layoutId) ?? new Set();
}

function withOwnParts(
  layout: Layout,
  cur: Layout | undefined,
  view: StageView | undefined,
  keepView: boolean,
): {
  layout: Layout;
  view: StageView | null;
} {
  const id = layout.id;
  const tiles = guardedTiles.get(id) ?? new Set<string>();
  guardedTiles.set(id, tiles);
  if (!cur) {
    for (const [tileId, c] of Object.entries(layout.charts)) {
      tiles.add(tileId);
      layoutGuard.agree(layoutKeys.chart(id, tileId), c);
    }
    layoutGuard.agree(layoutKeys.active(id), layout.activeChartId ?? null);
    const fresh = !keepView ? viewOfDock(layout.dock) : null;
    if (fresh) layoutGuard.agree(layoutKeys.view(id), fresh);
    const stored = layout.dock && typeof layout.dock === 'object' && DOCK_VIEW_KEY in layout.dock;
    return { layout, view: stored || !view ? fresh : null };
  }
  const charts: Record<string, ChartState> = {};
  for (const tileId of new Set([...Object.keys(layout.charts), ...Object.keys(cur.charts)])) {
    const theirs = layout.charts[tileId] ?? null;
    const mine = cur.charts[tileId] ?? null;
    tiles.add(tileId);
    const take = layoutGuard.admit(layoutKeys.chart(id, tileId), theirs, mine) ? theirs : mine;
    if (take) charts[tileId] = take;
  }
  const theirsActive = layout.activeChartId ?? null;
  const mineActive = cur.activeChartId ?? null;
  const active = layoutGuard.admit(layoutKeys.active(id), theirsActive, mineActive) ? theirsActive : mineActive;
  const stored = layout.dock && typeof layout.dock === 'object' && DOCK_VIEW_KEY in layout.dock;
  const theirsView = !keepView && (stored || !view) ? viewOfDock(layout.dock) : null;
  const nextView =
    theirsView && (!view || layoutGuard.admit(layoutKeys.view(id), theirsView, view)) ? theirsView : null;
  return { layout: { ...layout, charts, activeChartId: active }, view: nextView };
}

export function putLayout(layout: Layout, options: { keepView?: boolean } = {}): boolean {
  const s = read(layoutsStore);
  const cur = s.layouts[layout.id];
  if (cur && layout.revision < cur.revision) return false;
  const next = withOwnParts(layout, cur, s.views[layout.id], options.keepView ?? false);
  patch(layoutsStore, {
    layouts: { ...s.layouts, [layout.id]: next.layout },
    ...(next.view ? { views: { ...s.views, [layout.id]: next.view } } : {}),
  });
  return true;
}

const seeds = new Map<string, Layout>();
const creating = new Map<string, Promise<void>>();

export function seedLayout(layout: Layout, saved: Promise<{ revision: number }>): void {
  const id = layout.id;
  seeds.set(id, layout);
  const done = saved
    .then(
      (out) => setLayoutRevision(id, out.revision),
      () => undefined,
    )
    .finally(() => {
      seeds.delete(id);
      if (creating.get(id) === done) creating.delete(id);
    });
  creating.set(id, done);
}

export function takeSeededLayout(layoutId: string): Layout | null {
  const layout = seeds.get(layoutId) ?? null;
  seeds.delete(layoutId);
  return layout;
}

export function layoutCreated(layoutId?: string): Promise<void> | null {
  if (layoutId !== undefined) return creating.get(layoutId) ?? null;
  return creating.size > 0 ? Promise.all(creating.values()).then(() => undefined) : null;
}

export function setStageView(layoutId: string, change: Partial<StageView>): void {
  patch(layoutsStore, (s) => ({
    views: { ...s.views, [layoutId]: { ...(s.views[layoutId] ?? DEFAULT_VIEW), ...change } },
  }));
}

export function setLayoutCharts(layoutId: string, charts: Record<string, ChartState>): void {
  const s = read(layoutsStore);
  const cur = s.layouts[layoutId];
  if (!cur) return;
  patch(layoutsStore, { layouts: { ...s.layouts, [layoutId]: { ...cur, charts } } });
}

export function applyChartResult(layoutId: string, revision: number, chart: ChartState | null): void {
  const s = read(layoutsStore);
  const cur = s.layouts[layoutId];
  if (!cur || revision < cur.revision) return;
  if (chart) layoutGuard.agree(layoutKeys.chart(layoutId, chart.tileId), chart);
  patch(layoutsStore, {
    layouts: {
      ...s.layouts,
      [layoutId]: { ...cur, revision, charts: chart ? { ...cur.charts, [chart.tileId]: chart } : cur.charts },
    },
    chartToolRevision: { ...s.chartToolRevision, [layoutId]: revision },
  });
}

export function patchChart(layoutId: string, tileId: string, fn: (c: ChartState) => ChartState): ChartState | null {
  const s = read(layoutsStore);
  const cur = s.layouts[layoutId];
  const chart = cur?.charts[tileId];
  if (!cur || !chart) return null;
  const next = fn(chart);
  patch(layoutsStore, { layouts: { ...s.layouts, [layoutId]: { ...cur, charts: { ...cur.charts, [tileId]: next } } } });
  return next;
}

export function savingLayout(
  layoutId: string,
  sent: { charts: Record<string, ChartState>; view: StageView | null; activeChartId: string | null | undefined },
): () => void {
  const gone = [...guardedChartIds(layoutId)].filter((id) => !(id in sent.charts));
  const dones = [
    ...Object.entries(sent.charts).map(([id, c]) => layoutGuard.write(layoutKeys.chart(layoutId, id), c)),
    ...gone.map((id) => layoutGuard.write(layoutKeys.chart(layoutId, id), null)),
    ...(sent.view ? [layoutGuard.write(layoutKeys.view(layoutId), sent.view)] : []),
    ...(sent.activeChartId !== undefined ? [layoutGuard.write(layoutKeys.active(layoutId), sent.activeChartId)] : []),
  ];
  const s = read(layoutsStore);
  const cur = s.layouts[layoutId];
  if (cur && gone.some((id) => id in cur.charts)) {
    const charts = Object.fromEntries(Object.entries(cur.charts).filter(([id]) => !gone.includes(id)));
    patch(layoutsStore, { layouts: { ...s.layouts, [layoutId]: { ...cur, charts } } });
  }
  return () => {
    for (const done of dones) done();
  };
}

export function setLayoutRevision(layoutId: string, revision: number): void {
  const s = read(layoutsStore);
  const cur = s.layouts[layoutId];
  if (!cur || revision < cur.revision) return;
  patch(layoutsStore, { layouts: { ...s.layouts, [layoutId]: { ...cur, revision } } });
}

export function setActiveChart(layoutId: string, tileId: string): void {
  const s = read(layoutsStore);
  const cur = s.layouts[layoutId];
  if (!cur || cur.activeChartId === tileId) return;
  patch(layoutsStore, { layouts: { ...s.layouts, [layoutId]: { ...cur, activeChartId: tileId } } });
}

export function useLayouts<T>(selector: (s: LayoutsState) => T): T {
  return useStore(layoutsStore, selector);
}

export function useStageView(layoutId: string | null): StageView {
  return useLayouts((s) => (layoutId ? (s.views[layoutId] ?? DEFAULT_VIEW) : DEFAULT_VIEW));
}

export function useChartState(layoutId: string, tileId: string): ChartState | null {
  return useLayouts((s) => s.layouts[layoutId]?.charts[tileId] ?? null);
}

export const RETIRED_AREA_LAYOUTS: readonly string[] = ['research', 'journal', 'connections', 'agents', 'settings'];

export function chartTypeOf(
  view: StageView,
  tileId: string,
  fallback: ChartType,
  chart?: Pick<ChartState, 'chartType'> | null,
): SeriesType {
  return chart?.chartType ?? view.chartTypes[tileId] ?? fallback;
}

export type ChartSetup = Pick<ChartTemplate, 'layers' | 'chartType'>;

export function layersOfSetup(setup: ChartSetup | null): ChartLayer[] {
  const out: ChartLayer[] = [];
  for (const l of setup?.layers ?? []) {
    const n = out.filter((x) => x.kind === l.kind).length + 1;
    out.push({
      id: `${l.kind}-${String(n)}`,
      kind: l.kind,
      params: l.params,
      visible: l.visible,
      namespace: 'user',
      sessionId: null,
    });
  }
  return out;
}

export function defaultChartState(
  tileId: string,
  title: string,
  instrument: string,
  timeframe: ChartState['timeframe'],
  setup: ChartSetup | null = null,
): ChartState {
  return {
    tileId,
    title,
    instrument,
    timeframe,
    layers: layersOfSetup(setup),
    annotations: [],
    viewport: null,
    linkGroup: '1',
    ...(setup?.chartType ? { chartType: setup.chartType } : {}),
  };
}
