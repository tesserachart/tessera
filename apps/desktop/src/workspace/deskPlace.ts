import type { ChartState } from '@tessera/protocol';
import type { AddPanelOptions, DockviewApi, DockviewGroupPanel, IDockviewPanel, Position } from 'dockview-react';
import type { LayoutPreset } from '../state/layouts.ts';
import { edgeGroup, edgeOf, placeOf, type EdgePos } from './dock/edges.ts';
import { expandEdge } from './dock/motion.ts';
import type { ChartTileParams } from './layouts.ts';
import { presetColumns } from './presets.ts';

export const MAX_CHARTS = 24;

export const MAX_CHART_PANES = 6;

type Side = 'left' | 'right' | 'above' | 'below';

type GroupRef = DockviewGroupPanel | string;

export type DeskSpot =
  | { at: 'edge'; edge: EdgePos; index?: number }
  | { at: 'tabs'; group: GroupRef; index?: number }
  | { at: 'split'; group: GroupRef; side: Side }
  | { at: 'with'; panel: string }
  | { at: 'beside'; panel: string | null; side: Side }
  | { at: 'side'; side: Side }
  | { at: 'active' };

export type DeskPanel = Omit<AddPanelOptions, 'position' | 'floating'>;

function positionOf(spot: Exclude<DeskSpot, { at: 'edge' | 'active' }>): AddPanelOptions['position'] {
  switch (spot.at) {
    case 'tabs':
      return { referenceGroup: spot.group, ...(spot.index !== undefined ? { index: spot.index } : {}) };
    case 'split':
      return { referenceGroup: spot.group, direction: spot.side };
    case 'with':
      return { referencePanel: spot.panel, direction: 'within' };
    case 'beside':
      return spot.panel ? { referencePanel: spot.panel, direction: spot.side } : { direction: spot.side };
    case 'side':
      return { direction: spot.side };
  }
}

export function putOnDesk(api: DockviewApi, panel: DeskPanel, spot: DeskSpot): IDockviewPanel | null {
  if (spot.at === 'active') return api.addPanel(panel);
  if (spot.at === 'edge') {
    const group = edgeGroup(api, spot.edge);
    if (!group) return null;
    if (!api.isEdgeGroupVisible(spot.edge)) api.setEdgeGroupVisible(spot.edge, true);
    return api.addPanel({
      ...panel,
      position: { referenceGroup: group, ...(spot.index !== undefined ? { index: spot.index } : {}) },
    });
  }
  return api.addPanel({ ...panel, position: positionOf(spot) });
}

export type RailTarget =
  | { group: DockviewGroupPanel; position: Position; index?: number }
  | { group: null; position: Position }
  | { edge: EdgePos };

const DIRECTION: Record<Exclude<Position, 'center'>, Side> = {
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
};

export function splitsAt(group: DockviewGroupPanel): boolean {
  return placeOf(group) === 'centre' || placeOf(group) === 'floating';
}

function dropSpot(target: RailTarget): DeskSpot {
  if ('edge' in target) return { at: 'edge', edge: target.edge };
  if (!target.group) return { at: 'side', side: target.position === 'center' ? 'right' : DIRECTION[target.position] };
  const group = target.group;
  if (splitsAt(group) && target.position !== 'center') return { at: 'split', group, side: DIRECTION[target.position] };
  return { at: 'tabs', group, ...(target.index !== undefined ? { index: target.index } : {}) };
}

export function dropOnDesk(api: DockviewApi, target: RailTarget, panel: DeskPanel): IDockviewPanel | null {
  const added = putOnDesk(api, panel, dropSpot(target));
  const edge = 'edge' in target ? target.edge : target.group ? edgeOf(target.group) : null;
  if (added && edge) expandEdge(api, edge, 'pointer');
  return added;
}

export function chartTile(
  layoutId: string,
  chart: Pick<ChartState, 'tileId' | 'title'>,
): DeskPanel & { params: ChartTileParams } {
  return { id: chart.tileId, component: 'chart', title: chart.title, params: { layoutId, tileId: chart.tileId } };
}

const isChart = (p: IDockviewPanel) => p.api.component === 'chart';

function isCentre(group: DockviewGroupPanel): boolean {
  return placeOf(group) === 'centre';
}

function centreGroup(api: Pick<DockviewApi, 'groups'>, except?: DockviewGroupPanel): DockviewGroupPanel | null {
  return api.groups.find((g) => isCentre(g) && g !== except) ?? null;
}

export function firstCentreChart(api: Pick<DockviewApi, 'panels'>): IDockviewPanel | null {
  return api.panels.find((p) => isChart(p) && isCentre(p.group)) ?? null;
}

export function chartPanes(api: Pick<DockviewApi, 'panels'>): DockviewGroupPanel[] {
  const out: DockviewGroupPanel[] = [];
  for (const p of api.panels) if (isChart(p) && isCentre(p.group) && !out.includes(p.group)) out.push(p.group);
  return out;
}

export function chartsFit(charts: number): boolean {
  return charts < MAX_CHARTS;
}

export type ChartPlacement = 'split' | 'tab';

export function placeNewChart(want: ChartPlacement, charts: number, panes: number): ChartPlacement | null {
  if (!chartsFit(charts)) return null;
  return want === 'split' && panes >= MAX_CHART_PANES ? 'tab' : want;
}

export function splitSide(width: number, height: number): 'right' | 'below' {
  return height > width ? 'below' : 'right';
}

export interface NewChartSpot {
  placement: ChartPlacement;
  into: DockviewGroupPanel | null;
  pane: DockviewGroupPanel | null;
  anchor: IDockviewPanel | null;
}

export function newChartSpot(api: DockviewApi, want: NewChartSpot): DeskSpot {
  const live = (g: DockviewGroupPanel | null) => (g && api.groups.includes(g) ? g : null);
  const into = live(want.into);
  if (into) return { at: 'tabs', group: into };
  const anchor = live(want.pane) ?? want.anchor?.group ?? null;
  if (want.placement === 'tab') return anchor ? { at: 'tabs', group: anchor } : { at: 'side', side: 'right' };
  const pane = anchor && isCentre(anchor) ? anchor : (chartPanes(api)[0] ?? null);
  if (!pane) return { at: 'side', side: 'right' };
  return { at: 'split', group: pane, side: splitSide(pane.api.width, pane.api.height) };
}

export interface FoundPane {
  charts: string[];
}

export function panesOf(api: Pick<DockviewApi, 'panels'>, ids: readonly string[]): FoundPane[] {
  const byGroup = new Map<DockviewGroupPanel, string[]>();
  const panes: FoundPane[] = [];
  for (const id of ids) {
    const p = api.panels.find((x) => x.id === id);
    if (!p || !isCentre(p.group)) {
      panes.push({ charts: [id] });
      continue;
    }
    let list = byGroup.get(p.group);
    if (!list) {
      list = [];
      byGroup.set(p.group, list);
      panes.push({ charts: list });
    }
    list.push(id);
  }
  for (const [group, list] of byGroup) {
    const shown = group.activePanel?.id;
    if (shown && list.includes(shown)) list.splice(0, list.length, shown, ...list.filter((x) => x !== shown));
  }
  return panes;
}

export interface ArrangeSlot {
  lead: Pick<ChartState, 'tileId' | 'title'>;
  join: readonly string[];
}

export function arrangeCharts(
  api: DockviewApi,
  layoutId: string,
  slots: readonly ArrangeSlot[],
  preset: LayoutPreset,
): void {
  const cols = presetColumns(preset);
  const leads = new Set(slots.map((s) => s.lead.tileId));
  const panelOf = (slot: number): IDockviewPanel | null => {
    const c = slots[slot]?.lead;
    if (!c) return null;
    const have = api.getPanel(c.tileId);
    if (have) return have;
    const anchor = centreGroup(api);
    return putOnDesk(
      api,
      chartTile(layoutId, c),
      anchor ? { at: 'split', group: anchor, side: 'right' } : { at: 'side', side: 'left' },
    );
  };
  const ownPane = (p: IDockviewPanel) =>
    isCentre(p.group) && !p.group.panels.some((x) => x.id !== p.id && leads.has(x.id));
  const place = (p: IDockviewPanel, to: { group: DockviewGroupPanel; position: 'right' | 'bottom' }) => {
    if (ownPane(p)) p.group.api.moveTo({ ...to, skipSetActive: true });
    else p.api.moveTo(to);
  };
  const first = panelOf(0);
  if (!first) return;
  if (!isCentre(first.group)) {
    const centre = centreGroup(api, first.group);
    first.api.moveTo(centre ? { group: centre, position: 'left' } : { position: 'left' });
  } else if (!ownPane(first)) first.api.moveTo({ group: first.group, position: 'left' });
  const columnHeads: DockviewGroupPanel[] = [first.group];
  for (let c = 1; c < cols.length; c++) {
    const p = panelOf(cols[c]![0]!);
    if (!p) continue;
    place(p, { group: columnHeads[c - 1]!, position: 'right' });
    columnHeads.push(p.group);
  }
  cols.forEach((col, c) => {
    let above = columnHeads[c];
    for (const slot of col.slice(1)) {
      const p = panelOf(slot);
      if (!p || !above) continue;
      place(p, { group: above, position: 'bottom' });
      above = p.group;
    }
  });
  for (const s of slots) {
    const target = api.getPanel(s.lead.tileId)?.group;
    if (!target) continue;
    for (const id of s.join) {
      const p = api.getPanel(id);
      if (!p || p.group === target) continue;
      if (ownPane(p)) p.group.api.moveTo({ group: target, position: 'center', skipSetActive: true });
      else p.api.moveTo({ group: target, position: 'center', skipSetActive: true });
    }
  }
  equalize(api, cols, slots);
  api.getPanel(slots[0]!.lead.tileId)?.api.setActive();
}

function equalize(api: DockviewApi, cols: number[][], slots: readonly ArrangeSlot[]): void {
  const groupOf = (slot: number) => api.getPanel(slots[slot]?.lead.tileId ?? '')?.group ?? null;
  const heads = cols.map((col) => groupOf(col[0]!));
  const span = (g: DockviewGroupPanel | null, axis: 'width' | 'height') => (g ? g.api[axis] : 0);
  const total = heads.reduce((s, g) => s + span(g, 'width'), 0);
  if (cols.length > 1 && total > 0) {
    const w = Math.floor(total / cols.length);
    for (const g of heads.slice(0, -1)) g?.api.setSize({ width: w });
  }
  for (const col of cols) {
    if (col.length < 2) continue;
    const groups = col.map(groupOf);
    const h = groups.reduce((s, g) => s + span(g, 'height'), 0);
    if (h <= 0) continue;
    const each = Math.floor(h / col.length);
    for (const g of groups.slice(0, -1)) g?.api.setSize({ height: each });
  }
}
