import type { Timeframe } from '@tessera/protocol';
import { patch, read, makeStore, type Store, useStoreInSight } from '../app/store.ts';
import { useLayouts } from './layouts.ts';

export interface ActiveChartRef {
  layoutId: string;
  tileId: string;
  source: string | null;
}

export interface WorkspaceState {
  activeChart: ActiveChartRef | null;
  blockedLayout: string | null;
}

function makeWorkspaceStore(): Store<WorkspaceState> {
  return makeStore<WorkspaceState>({ activeChart: null, blockedLayout: null });
}

export const workspaceStore = makeWorkspaceStore();

export const setActiveChartRef = (activeChart: ActiveChartRef | null) => patch(workspaceStore, { activeChart });
export const setBlockedLayout = (blockedLayout: string | null) => patch(workspaceStore, { blockedLayout });

export function patchActiveChartRef(layoutId: string, tileId: string, change: Partial<ActiveChartRef>): void {
  const cur = read(workspaceStore).activeChart;
  if (cur?.layoutId !== layoutId || cur.tileId !== tileId) return;
  if (Object.entries(change).every(([k, v]) => cur[k as keyof ActiveChartRef] === v)) return;
  patch(workspaceStore, { activeChart: { ...cur, ...change } });
}

export function useWorkspace<T>(selector: (s: WorkspaceState) => T): T {
  return useStoreInSight(workspaceStore, selector);
}

export interface ActiveChart extends ActiveChartRef {
  title: string;
  instrument: string;
  tf: Timeframe;
  layerCount: number;
}

export function useActiveChart(): ActiveChart | null {
  const ref = useWorkspace((s) => s.activeChart);
  const chart = useLayouts((s) => (ref ? (s.layouts[ref.layoutId]?.charts[ref.tileId] ?? null) : null));
  if (!ref || !chart) return null;
  return {
    ...ref,
    title: chart.title,
    instrument: chart.instrument,
    tf: chart.timeframe,
    layerCount: chart.layers.filter((l) => l.visible).length,
  };
}
