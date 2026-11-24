import {
  type ChartHours,
  type ChartState,
  type JsonValue,
  type Layout,
  type PrintBars,
  type Timeframe,
} from '@tessera/protocol';
import { withHours } from '../chart/hours.ts';
import type { DockviewApi } from 'dockview-react';
import {
  DEFAULT_VIEW,
  DOCK_VIEW_KEY,
  dockTreeOf,
  type LayoutPreset,
  type SeriesType,
  layoutCreated,
  layoutsStore,
  setLayoutRevision,
  putLayout,
  savingLayout,
  layoutGuard,
  layoutKeys,
  applyChartResult,
  patchChart,
  setLayoutCharts,
  setStageView,
  setActiveChart,
} from '../state/layouts.ts';
import { addRecentSymbol } from '../state/ui.ts';
import { setActiveChartRef, workspaceStore } from '../state/workspace.ts';
import { arrangeCharts, chartsFit, panesOf, type ArrangeSlot } from './deskPlace.ts';
import { chartFocusOrder, noteChartFocus, successorChart } from './chartFocus.ts';
import { momentaryOpen } from './dock/edges.ts';
import { buildDockFromLayout, chartPanelIds, dockShape, isLoadableDock } from './layouts.ts';
import { nextChartId, presetCount, storyCollapsed, storyPreset } from './presets.ts';
import { restoreUnknownTiles } from './tiles/registry.ts';
import { read } from '../app/store.ts';
import { runTool, toolCode } from '../app/tools.ts';
import { keepLocalChartChange } from '../shell/deskWords.ts';

export interface WorkspaceContext {
  api: DockviewApi;
  layoutId: string;
  tools: ReadonlySet<string>;
  reload: () => void;
  canSaveDock: () => boolean;
  allowDockSaves: () => void;
  tileWindows?: boolean;
  popout?: boolean;
  windowPanel?: string;
  flush?: () => Promise<void>;
}

let current: WorkspaceContext | null = null;
const live = new Map<WorkspaceContext, number>();
const saves = new Map<WorkspaceContext, { running: Promise<void>; again: boolean }>();
let writesStopped = false;

export function stopLayoutWrites(): void {
  writesStopped = true;
}

const inStep = new Map<string, string>();

export function noteDockInStep(layoutId: string, tree: unknown): void {
  inStep.set(layoutId, dockShape(tree));
}

export function keepsOwnDock(latest: Layout, base: string | undefined, chartIds: ReadonlySet<string>): boolean {
  if (base === undefined || !isLoadableDock(latest.dock)) return false;
  const ids = Object.keys(latest.charts);
  if (ids.length !== chartIds.size || ids.some((id) => !chartIds.has(id))) return false;
  return dockShape(dockTreeOf(latest.dock)) === base;
}

const REBASES = 2;

function hold(ctx: WorkspaceContext): () => void {
  live.set(ctx, (live.get(ctx) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (live.get(ctx) ?? 1) - 1;
    if (n > 0) live.set(ctx, n);
    else live.delete(ctx);
  };
}

export function mountWorkspace(ctx: WorkspaceContext): () => void {
  return hold(ctx);
}

export function attachWorkspace(ctx: WorkspaceContext): () => void {
  current = ctx;
  const release = hold(ctx);
  return () => {
    release();
    if (current === ctx) current = null;
  };
}

export function workspaceContext(): WorkspaceContext | null {
  return current;
}

export function deskContextOf(layoutId: string): WorkspaceContext | null {
  if (current?.layoutId === layoutId && !current.popout) return current;
  for (const ctx of live.keys()) if (ctx.layoutId === layoutId && !ctx.popout) return ctx;
  return null;
}

export function contextOf(api: DockviewApi): WorkspaceContext | null {
  if (current?.api === api) return current;
  for (const ctx of live.keys()) if (ctx.api === api) return ctx;
  return null;
}

export function activeChartTarget(ctx: WorkspaceContext | null = current): { layoutId: string; tileId: string } | null {
  if (!ctx) return null;
  const layout = read(layoutsStore).layouts[ctx.layoutId];
  if (!layout) return null;
  const ref = read(workspaceStore).activeChart;
  if (ref?.layoutId === ctx.layoutId && layout.charts[ref.tileId])
    return { layoutId: ctx.layoutId, tileId: ref.tileId };
  const panels = chartPanelIds(ctx.api);
  const tileId =
    (layout.activeChartId && layout.charts[layout.activeChartId] ? layout.activeChartId : panels[0]) ?? null;
  return tileId ? { layoutId: ctx.layoutId, tileId } : null;
}

export async function saveLayout(target: WorkspaceContext | null = current): Promise<void> {
  const ctx = target;
  if (!ctx || writesStopped) return;
  const inflight = saves.get(ctx);
  if (inflight) {
    inflight.again = true;
    return inflight.running;
  }
  const state = { running: Promise.resolve(), again: false };
  const againRequested = () => state.again;
  const run = async () => {
    let rebases = 0;
    do {
      state.again = false;
      const making = layoutCreated(ctx.layoutId);
      if (making) await making;
      if (!live.has(ctx) || !ctx.tools.has('layout.save')) return;
      const layout = read(layoutsStore).layouts[ctx.layoutId];
      if (!layout) return;
      const present = new Set([...chartPanelIds(ctx.api), ...popped(ctx.layoutId)]);
      const charts: Record<string, ChartState> = {};
      for (const [id, c] of Object.entries(layout.charts)) if (ctx.popout || present.has(id)) charts[id] = c;
      const active = read(workspaceStore).activeChart;
      const shownChartId = ctx.popout
        ? undefined
        : active?.layoutId === ctx.layoutId
          ? active.tileId
          : (layout.activeChartId ?? undefined);
      const activeChartId = shownChartId && charts[shownChartId] ? shownChartId : undefined;
      try {
        const view = read(layoutsStore).views[ctx.layoutId] ?? DEFAULT_VIEW;
        const tree = withUserCollapse(restoreUnknownTiles(ctx.api.toJSON()), {
          ...momentaryOpen(),
          ...view.collapsed,
        }) as Record<string, JsonValue>;
        const withDock = ctx.canSaveDock();
        const dock = withDock ? { dock: { ...tree, [DOCK_VIEW_KEY]: view } as unknown as JsonValue } : {};
        const sent = savingLayout(ctx.layoutId, { charts, view: withDock ? view : null, activeChartId });
        const out = await runTool('layout.save', {
          layoutId: ctx.layoutId,
          expectedRevision: layout.revision,
          ...dock,
          charts,
          ...(activeChartId ? { activeChartId } : {}),
        }).finally(sent);
        setLayoutRevision(ctx.layoutId, out.revision);
        if (withDock) noteDockInStep(ctx.layoutId, tree);
      } catch (err) {
        if (toolCode(err) === 'conflict') {
          if (rebases++ < REBASES && ctx.canSaveDock() && (await rebase(ctx, new Set(Object.keys(charts))))) {
            state.again = true;
            continue;
          }
          ctx.reload();
          return;
        }
        console.warn(`[workspace] layout.save ${ctx.layoutId} failed`, err);
        return;
      }
    } while (againRequested());
  };
  state.running = run().finally(() => {
    if (saves.get(ctx) === state) saves.delete(ctx);
  });
  saves.set(ctx, state);
  return state.running;
}

async function rebase(ctx: WorkspaceContext, chartIds: ReadonlySet<string>): Promise<boolean> {
  let latest: Layout;
  try {
    latest = await runTool('layout.get', { layoutId: ctx.layoutId });
  } catch {
    return false;
  }
  if (!live.has(ctx) || !keepsOwnDock(latest, inStep.get(ctx.layoutId), chartIds)) return false;
  putLayout(latest, { keepView: true });
  return true;
}

export function withUserCollapse(tree: unknown, collapsed: Partial<Record<string, boolean>>): unknown {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return tree;
  const t = tree as Record<string, unknown>;
  const edges = t.edgeGroups as Record<string, Record<string, unknown> | undefined> | undefined;
  if (!edges) return tree;
  const next: Record<string, unknown> = {};
  for (const [pos, e] of Object.entries(edges)) {
    const want = collapsed[pos];
    if (!e || want === undefined || (e.collapsed === true) === want) {
      next[pos] = e;
      continue;
    }
    const { collapsed: _c, ...rest } = e;
    const group = rest.group as Record<string, unknown> | undefined;
    next[pos] = {
      ...rest,
      ...(want ? { collapsed: true } : {}),
      ...(group ? { group: { ...group, headerPosition: want ? pos : 'top' } } : {}),
    };
  }
  return { ...t, edgeGroups: next };
}

async function changeChart(
  tool:
    | 'chart.set_symbol'
    | 'chart.set_timeframe'
    | 'chart.set_chart_type'
    | 'chart.set_hours'
    | 'chart.set_drawing_sources',
  input:
    | { instrument: string }
    | { tf: Timeframe; printBars?: PrintBars }
    | { chartType: SeriesType }
    | { hours: ChartHours }
    | { from: string[] },
  local: (c: ChartState) => ChartState,
  tile?: { layoutId: string; tileId: string },
): Promise<boolean> {
  const ctx = current;
  const target = tile ?? activeChartTarget();
  if (!ctx || !target) return false;
  if (ctx.tools.has(tool)) {
    const before = read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId] ?? null;
    const shown = patchChart(target.layoutId, target.tileId, local);
    const done = shown ? layoutGuard.write(layoutKeys.chart(target.layoutId, target.tileId), shown) : () => true;
    try {
      await layoutSaved();
      const out = await runTool(tool, { layoutId: target.layoutId, tileId: target.tileId, ...input });
      applyChartResult(out.layoutId, out.revision, done(out.chart) ? out.chart : null);
      return true;
    } catch (err) {
      console.warn(`[workspace] ${tool} failed`, err);
      if (keepLocalChartChange(err) && shown) {
        done(shown);
        return true;
      }
      if (done(before ?? undefined) && before) patchChart(target.layoutId, target.tileId, () => before);
      return false;
    }
  }
  if (!patchChart(target.layoutId, target.tileId, local)) return false;
  await saveLayout();
  return true;
}

export async function setChartInstrument(instrument: string): Promise<boolean> {
  const ok = await changeChart('chart.set_symbol', { instrument }, (c) => ({ ...c, instrument, annotations: [] }));
  if (ok) {
    const target = activeChartTarget();
    const chart = target ? read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId] : null;
    addRecentSymbol(chart?.instrument ?? instrument);
  }
  return ok;
}

export function showOnChart(instrument: string, tile: { layoutId: string; tileId: string }): Promise<boolean> {
  return changeChart('chart.set_symbol', { instrument }, (c) => ({ ...c, instrument, annotations: [] }), tile);
}

export async function setChartTimeframe(
  tf: Timeframe,
  tile?: { layoutId: string; tileId: string },
  printBars: PrintBars | null = null,
): Promise<boolean> {
  const ctx = current;
  const target = tile ?? activeChartTarget();
  if (!ctx || !target) return false;
  const ok = await changeChart(
    'chart.set_timeframe',
    printBars ? { tf, printBars } : { tf },
    (c) => {
      const next: ChartState = { ...c, timeframe: tf };
      if (printBars) next.printBars = printBars;
      else delete next.printBars;
      return next;
    },
    target,
  );
  if (ok && read(layoutsStore).views[target.layoutId]?.syncInterval) {
    const others = Object.values(read(layoutsStore).layouts[target.layoutId]?.charts ?? {}).filter(
      (c) => c.tileId !== target.tileId && c.timeframe !== tf,
    );
    for (const c of others) {
      await changeChart('chart.set_timeframe', { tf }, (x) => ({ ...x, timeframe: tf }), {
        layoutId: target.layoutId,
        tileId: c.tileId,
      });
    }
  }
  return ok;
}

export function applyLayoutPreset(preset: LayoutPreset): boolean {
  const ctx = current;
  if (!ctx) return false;
  const layout = read(layoutsStore).layouts[ctx.layoutId];
  if (!layout) return false;
  const count = presetCount(preset);
  const target = activeChartTarget();
  const away = popped(ctx.layoutId);
  const ids = chartPanelIds(ctx.api).filter((id) => layout.charts[id]);
  for (const id of Object.keys(layout.charts)) if (!ids.includes(id) && !away.has(id)) ids.push(id);
  let panes = panesOf(ctx.api, ids).map((p) => [...p.charts]);
  const activePane = panes.findIndex((p) => target && p.includes(target.tileId));
  if (activePane < 0 && panes.length === 0) return false;
  if (activePane >= count) panes = [panes[activePane]!, ...panes.filter((_, i) => i !== activePane)];
  const lead = layout.charts[target?.tileId ?? ''] ?? layout.charts[panes[0]![0]!]!;
  const charts = { ...layout.charts };
  while (panes.length < count) {
    if (chartsFit(Object.keys(charts).length)) {
      const tileId = nextChartId([...Object.keys(charts), ...away]);
      charts[tileId] = {
        ...lead,
        tileId,
        title: `Chart ${tileId.replace('chart-', '')}`,
        layers: lead.layers.filter((l) => l.namespace === 'user'),
        annotations: [],
        viewport: null,
        linkGroup: lead.linkGroup,
      };
      panes.push([tileId]);
      continue;
    }
    const fullest = panes.reduce((a, b) => (b.length > a.length ? b : a));
    if (fullest.length < 2) break;
    panes.push([fullest.pop()!]);
  }
  const slots: ArrangeSlot[] = panes.slice(0, count).map((p, i, kept) => ({
    lead: charts[p[0]!]!,
    join: [...p.slice(1), ...(i === kept.length - 1 ? panes.slice(count).flat() : [])],
  }));
  setLayoutCharts(ctx.layoutId, charts);
  setStageView(ctx.layoutId, { preset });
  arrangeCharts(ctx.api, ctx.layoutId, slots, preset);
  const keep = target && ctx.api.getPanel(target.tileId) ? target.tileId : slots[0]!.lead.tileId;
  ctx.api.getPanel(keep)?.api.setActive();
  ctx.allowDockSaves();
  void saveLayout();
  return true;
}

export function setTileInstrument(tile: { layoutId: string; tileId: string }, instrument: string): Promise<boolean> {
  return changeChart('chart.set_symbol', { instrument }, (c) => ({ ...c, instrument, annotations: [] }), tile);
}

export async function setChartLink(tileId: string, group: string | null): Promise<void> {
  const ctx = current;
  if (!ctx) return;
  const layout = read(layoutsStore).layouts[ctx.layoutId];
  const chart = layout?.charts[tileId];
  if (!layout || !chart || chart.linkGroup === group) return;
  const lead = group
    ? Object.values(layout.charts).find((c) => c.tileId !== tileId && c.linkGroup === group)
    : undefined;
  patchChart(ctx.layoutId, tileId, (c) => ({
    ...c,
    linkGroup: group,
    ...(lead && lead.instrument !== c.instrument
      ? { instrument: lead.instrument, annotations: [], viewport: null }
      : {}),
  }));
  await saveLayout();
}

export function allChartsLinked(charts: readonly Pick<ChartState, 'linkGroup'>[]): boolean {
  const first = charts[0]?.linkGroup ?? null;
  return first !== null && charts.every((c) => c.linkGroup === first);
}

export async function linkAllCharts(on: boolean): Promise<void> {
  const ctx = current;
  const target = activeChartTarget();
  if (!ctx || !target) return;
  const layout = read(layoutsStore).layouts[ctx.layoutId];
  const active = layout?.charts[target.tileId];
  if (!layout || !active) return;
  const charts = Object.fromEntries(
    Object.values(layout.charts).map((c) => [
      c.tileId,
      {
        ...c,
        linkGroup: on ? '1' : null,
        ...(on && c.instrument !== active.instrument
          ? { instrument: active.instrument, annotations: [], viewport: null }
          : {}),
      },
    ]),
  );
  setLayoutCharts(ctx.layoutId, charts);
  await saveLayout();
}

export async function setSyncInterval(on: boolean): Promise<void> {
  const ctx = current;
  const target = activeChartTarget();
  if (!ctx || !target) return;
  setStageView(ctx.layoutId, { syncInterval: on });
  const tf = read(layoutsStore).layouts[ctx.layoutId]?.charts[target.tileId]?.timeframe;
  if (on && tf) await setChartTimeframe(tf);
  else await saveLayout();
}

export async function setChartType(type: SeriesType, tile?: { layoutId: string; tileId: string }): Promise<void> {
  const ctx = current;
  const target = tile ?? activeChartTarget();
  if (!ctx || !target) return;
  const view = read(layoutsStore).views[ctx.layoutId] ?? DEFAULT_VIEW;
  const stale = target.tileId in view.chartTypes;
  if (stale) {
    const { [target.tileId]: _old, ...rest } = view.chartTypes;
    setStageView(ctx.layoutId, { chartTypes: rest });
  }
  await changeChart('chart.set_chart_type', { chartType: type }, (c) => ({ ...c, chartType: type }), target);
  if (stale) await saveLayout();
}

function withDrawingSources(c: ChartState, from: readonly string[]): ChartState {
  const { drawingsFrom: _was, ...rest } = c;
  return from.length > 0 ? { ...rest, drawingsFrom: [...from] } : rest;
}

export async function setDrawingSources(
  from: readonly string[],
  tile: { layoutId: string; tileId: string },
): Promise<boolean> {
  return changeChart('chart.set_drawing_sources', { from: [...from] }, (c) => withDrawingSources(c, from), tile);
}

export async function setChartHours(hours: ChartHours, tile?: { layoutId: string; tileId: string }): Promise<void> {
  await changeChart('chart.set_hours', { hours }, (c) => withHours(c, hours), tile);
}

export async function layoutSaved(): Promise<void> {
  await layoutCreated();
  if (saves.size > 0) await Promise.all([...saves.values()].map((s) => s.running));
}

export async function updateChart(layoutId: string, tileId: string, fn: (c: ChartState) => ChartState): Promise<void> {
  if (!patchChart(layoutId, tileId, fn)) return;
  await saveLayout();
}

export function popped(layoutId: string): ReadonlySet<string> {
  const view = read(layoutsStore).views[layoutId] ?? DEFAULT_VIEW;
  return new Set(view.popouts.map((p) => p.panelId));
}

export function resetWorkspaceLayout(): boolean {
  const ctx = current;
  if (!ctx) return false;
  const layout = read(layoutsStore).layouts[ctx.layoutId];
  if (!layout) return false;
  const view = read(layoutsStore).views[ctx.layoutId] ?? DEFAULT_VIEW;
  const story = view.story ? storyPreset(view.story) : null;
  buildDockFromLayout(ctx.api, layout, { popped: popped(ctx.layoutId), story });
  setStageView(ctx.layoutId, {
    preset: story?.arrange ?? null,
    collapsed: story ? storyCollapsed(story) : {},
    closed: [],
    maximised: null,
  });
  ctx.allowDockSaves();
  void saveLayout();
  return true;
}

export function activateChart(layoutId: string, tileId: string, source?: string): void {
  const ws = read(workspaceStore);
  const cur = ws.activeChart;
  if (cur?.layoutId === layoutId && cur.tileId === tileId) return;
  noteChartFocus(layoutId, tileId);
  setActiveChartRef({ layoutId, tileId, source: source ?? null });
  setActiveChart(layoutId, tileId);
}

export function releaseActiveChart(layoutId: string, tileId: string): void {
  const cur = read(workspaceStore).activeChart;
  if (cur?.layoutId !== layoutId || cur.tileId !== tileId) return;
  const ctx = workspaceContext();
  const charts = read(layoutsStore).layouts[layoutId]?.charts ?? {};
  const docked = ctx?.layoutId === layoutId ? chartPanelIds(ctx.api).filter((id) => charts[id]) : [];
  const next = successorChart(chartFocusOrder(layoutId), docked, tileId);
  if (next) activateChart(layoutId, next);
  else setActiveChartRef(null);
}
