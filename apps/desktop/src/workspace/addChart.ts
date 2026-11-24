import type { ChartState } from '@tessera/protocol';
import type { DockviewGroupPanel } from 'dockview-react';
import { newChartSetup } from '../chart/templates/model.ts';
import { templatesStore } from '../chart/templates/store.ts';
import { preferredInstrument } from '../frame/workspaces.ts';
import { defaultChartState, layoutsStore, setLayoutCharts, setStageView } from '../state/layouts.ts';
import { addRecentSymbol, openPalette, openSymbolSearch } from '../state/ui.ts';
import {
  activateChart,
  activeChartTarget,
  popped,
  saveLayout,
  setChartInstrument,
  setTileInstrument,
  workspaceContext,
} from './controller.ts';
import { deskToasts } from './dock/deskToasts.ts';
import { syncEdgeChrome } from './dock/edges.ts';
import {
  chartPanes,
  chartsFit,
  chartTile,
  MAX_CHARTS,
  newChartSpot,
  placeNewChart,
  putOnDesk,
  type ChartPlacement,
} from './deskPlace.ts';
import { chartPanelIds } from './layouts.ts';
import { nextChartId } from './presets.ts';
import { read } from '../app/store.ts';

const FULL_KEY = 'charts-full';

export function chartsFull(): boolean {
  const ctx = workspaceContext();
  const layout = ctx ? read(layoutsStore).layouts[ctx.layoutId] : undefined;
  return !!layout && !chartsFit(Object.keys(layout.charts).length);
}

export interface AddChartOptions {
  instrument?: string | null;
  placement: ChartPlacement;
  beside?: string | null;
  into?: DockviewGroupPanel | null;
  pane?: DockviewGroupPanel | null;
  activate?: boolean;
}

export async function addChart(opts: AddChartOptions): Promise<string | null> {
  const ctx = workspaceContext();
  const layout = ctx ? read(layoutsStore).layouts[ctx.layoutId] : undefined;
  if (!ctx || !layout || ctx.popout) return null;
  const { api, layoutId } = ctx;
  const inDock = (id: string | null | undefined): id is string => !!id && !!layout.charts[id] && !!api.getPanel(id);
  const was = activeChartTarget()?.tileId ?? null;
  const anchorId = [opts.beside, was].find(inDock) ?? chartPanelIds(api).find(inDock) ?? null;
  const anchorPanel = anchorId ? (api.getPanel(anchorId) ?? null) : null;
  const anchor: ChartState | null = anchorId ? (layout.charts[anchorId] ?? null) : null;
  const placement = placeNewChart(opts.placement, Object.keys(layout.charts).length, chartPanes(api).length);
  if (!placement) return null;

  const instrument =
    opts.instrument ?? anchor?.instrument ?? Object.values(layout.charts)[0]?.instrument ?? preferredInstrument();
  if (!instrument) {
    openSymbolSearch('', opts.placement === 'tab' ? 'tab' : 'change');
    return null;
  }
  const tileId = nextChartId([...Object.keys(layout.charts), ...chartPanelIds(api), ...popped(layoutId)]);
  const tpl = read(templatesStore);
  const fresh = defaultChartState(
    tileId,
    `Chart ${tileId.replace('chart-', '')}`,
    instrument,
    anchor?.timeframe ?? '5m',
    newChartSetup(tpl, tpl.loaded),
  );
  const chart: ChartState = { ...fresh, linkGroup: anchor?.instrument === instrument ? anchor.linkGroup : null };
  setLayoutCharts(layoutId, { ...layout.charts, [tileId]: chart });

  const focused = api.activePanel ?? null;
  const spot = newChartSpot(api, { placement, into: opts.into ?? null, pane: opts.pane ?? null, anchor: anchorPanel });
  const panel = putOnDesk(api, chartTile(layoutId, chart), spot);
  const shown = (id: string | null) => !!id && api.getPanel(id)?.group.activePanel?.id === id;
  if (opts.activate === false && was && shown(was)) {
    if (focused && focused.id !== panel?.id) focused.api.setActive();
    activateChart(layoutId, was);
  } else activateChart(layoutId, tileId);
  syncEdgeChrome(api);
  if (placement === 'split') setStageView(layoutId, { preset: null });
  await saveLayout();
  if (opts.instrument) {
    if (chart.linkGroup === null && instrument !== anchor?.instrument && ctx.tools.has('chart.set_symbol'))
      await setTileInstrument({ layoutId, tileId }, instrument);
    addRecentSymbol(read(layoutsStore).layouts[layoutId]?.charts[tileId]?.instrument ?? instrument);
  }
  return tileId;
}

function sayFull(): void {
  deskToasts.push({
    key: FULL_KEY,
    tone: 'info',
    title: `${String(MAX_CHARTS)} charts is the most a workspace holds`,
    detail: 'Close one to add another',
  });
}

export function newChartTab(beside?: string | null): void {
  if (chartsFull()) {
    sayFull();
    return;
  }
  const ctx = workspaceContext();
  if (!ctx || ctx.popout) return;
  const docked = (id: string | null | undefined): id is string => !!id && !!ctx.api.getPanel(id);
  const id = [beside, activeChartTarget()?.tileId].find(docked) ?? chartPanelIds(ctx.api)[0] ?? null;
  if (id) {
    activateChart(ctx.layoutId, id);
    openSymbolSearch('', 'tab');
  } else if (popped(ctx.layoutId).size > 0) openSymbolSearch('', 'tab', 'desk');
  else openPalette('');
}

export async function splitChart(pane?: DockviewGroupPanel | null): Promise<string | null> {
  if (chartsFull()) {
    sayFull();
    return null;
  }
  const beside = pane?.activePanel?.id ?? null;
  return addChart({ placement: 'split', beside, pane: pane ?? null, activate: true });
}

export async function openChartTab(instrument: string): Promise<string | null> {
  const id = await addChart({ instrument, placement: 'tab', activate: true });
  if (id === null && chartsFull()) sayFull();
  return id;
}

export async function showInstrument(instrument: string): Promise<boolean> {
  if (activeChartTarget()) return setChartInstrument(instrument);
  return (await openChartTab(instrument)) !== null;
}

export async function splitWithSymbol(instrument: string): Promise<boolean> {
  if (chartsFull()) return setChartInstrument(instrument);
  return (await addChart({ instrument, placement: 'split', activate: true })) !== null;
}
