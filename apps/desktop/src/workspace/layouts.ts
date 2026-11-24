import type { ChartState, JsonValue, Layout } from '@tessera/protocol';
import type { DockviewApi } from 'dockview-react';
import { defaultChartState, type ChartSetup } from '../state/layouts.ts';
import { edgeGroup, ensureEdges, syncEdgeChrome, EDGES, type EdgePos } from './dock/edges.ts';
import { chartTile, putOnDesk } from './deskPlace.ts';
import { storyAnalystWidth, storyCollapsed, type StoryPreset } from './presets.ts';
import { singletonPanelId, tileDefinition } from './tiles/registry.ts';
import { stableStringify } from '../app/stableJson.ts';

export { stableStringify };

export interface ChartTileParams {
  layoutId: string;
  tileId: string;
}

export function newWorkspaceLayout(
  layoutId: string,
  nowNs: number,
  opts: {
    name?: string;
    instrument?: string | null;
    timeframe?: ChartState['timeframe'];
    setup?: ChartSetup | null;
  } = {},
): Layout {
  const instrument = opts.instrument?.trim() ?? '';
  const chart = instrument
    ? defaultChartState('chart-1', 'Chart 1', instrument, opts.timeframe ?? '5m', opts.setup ?? null)
    : null;
  return {
    id: layoutId,
    name: opts.name ?? 'Trade',
    revision: 0,
    updatedAt: nowNs,
    activeChartId: chart?.tileId ?? null,
    dock: null,
    trade: null,
    charts: chart ? { [chart.tileId]: chart } : {},
  };
}

export function chartPanelIds(api: Pick<DockviewApi, 'panels'>): string[] {
  return api.panels.filter((p) => p.view.contentComponent === 'chart').map((p) => p.id);
}

export type PoppedIds = ReadonlySet<string>;

export function isLoadableDock(dock: JsonValue | undefined): boolean {
  return !!dock && typeof dock === 'object' && !Array.isArray(dock) && 'grid' in dock && 'panels' in dock;
}

const PIXEL_KEYS = new Set(['size', 'height', 'width', 'position', 'collapsed', 'headerPosition']);

function withoutPixels(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(withoutPixels);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (
      PIXEL_KEYS.has(k) &&
      (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string' || k === 'position')
    )
      continue;
    out[k] = withoutPixels(x);
  }
  return out;
}

export function dockShape(dock: unknown): string {
  return stableStringify(withoutPixels(dock));
}

export function buildDockFromLayout(
  api: DockviewApi,
  layout: Layout,
  opts: {
    collapsed?: Partial<Record<EdgePos, boolean>>;
    popped?: PoppedIds;
    story?: StoryPreset | null;
  } = {},
): void {
  api.clear();
  const story = opts.story ?? null;
  const collapsed = story ? storyCollapsed(story) : (opts.collapsed ?? {});
  const windowWidth = typeof window === 'undefined' ? api.width : window.innerWidth;
  const sizes: Partial<Record<EdgePos, number>> = story
    ? {
        right: storyAnalystWidth(story, windowWidth),
        ...(story.bottom !== null ? { bottom: story.bottom } : {}),
      }
    : {};
  const charts = Object.values(layout.charts).filter((c) => !opts.popped?.has(c.tileId));
  let prev: string | null = null;
  for (const c of charts) {
    putOnDesk(api, chartTile(layout.id, c), { at: 'beside', panel: prev, side: 'right' });
    prev = c.tileId;
  }
  ensureEdges(api, { collapsed, sizes });
  const away = opts.popped ?? new Set<string>();
  addDefaultPanels(api, away);
  if (story && !story.trade) showInGroup(api, 'analyst');
  const first = charts[0]?.tileId ?? null;
  if (story && first) addStoryTiles(api, story, first, away);
  for (const pos of EDGES) {
    const g = api.getEdgeGroup(pos);
    if (!g) continue;
    const want = collapsed[pos] ?? false;
    const size = sizes[pos];
    if (!want && g.isCollapsed()) g.expand();
    if (size && !g.isCollapsed()) g.setSize(pos === 'bottom' ? { height: size } : { width: size });
    if (want && !g.isCollapsed()) g.collapse();
  }
  syncEdgeChrome(api);
  if (first) api.getPanel(first)?.api.setActive();
}

function addStoryTiles(api: DockviewApi, story: StoryPreset, chartId: string, away: PoppedIds): void {
  for (const t of story.tiles) {
    let lead: string | null = null;
    for (const kind of t.kinds) {
      const def = tileDefinition(kind);
      if (!def) continue;
      if (def.add && !def.singleton) {
        def.add(api, { beside: chartId, ...(t.params ? { params: t.params } : {}) });
        continue;
      }
      const id = singletonPanelId(kind) ?? `${kind}-1`;
      if (api.getPanel(id) || away.has(id)) continue;
      putOnDesk(
        api,
        {
          id,
          component: def.kind,
          title: def.title,
          ...(t.params ? { params: { ...t.params } } : {}),
          inactive: lead !== null,
        },
        lead
          ? { at: 'with', panel: lead }
          : { at: 'beside', panel: chartId, side: t.at === 'right' ? 'right' : 'below' },
      );
      if (!lead) {
        lead = id;
        if (t.size) api.getPanel(id)?.group.api.setSize({ width: t.size });
      }
    }
  }
}

const DEFAULT_DESK: readonly { kind: string; edge: EdgePos }[] = [
  { kind: 'trade', edge: 'right' },
  { kind: 'analyst', edge: 'right' },
  { kind: 'positions', edge: 'bottom' },
  { kind: 'accounts', edge: 'bottom' },
];

function addDefaultPanels(api: DockviewApi, away: PoppedIds = new Set()): void {
  for (const { kind, edge } of DEFAULT_DESK) {
    const def = tileDefinition(kind);
    const id = singletonPanelId(kind);
    const group = edgeGroup(api, edge);
    if (!def || !id || !group || api.getPanel(id) || away.has(id)) continue;
    putOnDesk(api, { id, component: def.kind, title: def.title, inactive: true }, { at: 'tabs', group });
  }
  for (const pos of EDGES) {
    const first = DEFAULT_DESK.find((d) => d.edge === pos);
    const group = edgeGroup(api, pos);
    const panel = first ? api.getPanel(singletonPanelId(first.kind) ?? first.kind) : null;
    if (group && panel?.group === group && group.activePanel?.id !== panel.id)
      group.model.openPanel(panel, { skipSetGroupActive: true });
  }
}

function showInGroup(api: DockviewApi, kind: string): void {
  const panel = api.getPanel(singletonPanelId(kind) ?? kind);
  if (panel && panel.group.activePanel?.id !== panel.id)
    panel.group.model.openPanel(panel, { skipSetGroupActive: true });
}

export function reconcileDock(api: DockviewApi, layout: Layout, popped: PoppedIds = new Set()): void {
  const panels = new Set(chartPanelIds(api));
  for (const id of panels) if (!layout.charts[id] || popped.has(id)) api.getPanel(id)?.api.close();
  const anchor = chartPanelIds(api)[0] ?? null;
  for (const c of Object.values(layout.charts)) {
    if (panels.has(c.tileId) || popped.has(c.tileId)) continue;
    putOnDesk(api, chartTile(layout.id, c), anchor ? { at: 'with', panel: anchor } : { at: 'side', side: 'right' });
  }
}
