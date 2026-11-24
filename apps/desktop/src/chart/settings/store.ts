import { patch, makeStore, useStore } from '../../app/store.ts';

export const ADD_INDICATOR_KEY = 'alt+i';

export interface ChartRef {
  layoutId: string;
  tileId: string;
}

export interface IndicatorUiState {
  adding: ChartRef | null;
  editing: (ChartRef & { layerId: string }) | null;
}

export const indicatorUiStore = makeStore<IndicatorUiState>({ adding: null, editing: null });

export function useIndicatorUi<T>(selector: (s: IndicatorUiState) => T): T {
  return useStore(indicatorUiStore, selector);
}

export const openAdd = (chart: ChartRef) =>
  patch(indicatorUiStore, { adding: { layoutId: chart.layoutId, tileId: chart.tileId }, editing: null });
export const closeAdd = () => patch(indicatorUiStore, { adding: null });
export const openIndicatorSettings = (chart: ChartRef, layerId: string) =>
  patch(indicatorUiStore, { editing: { layoutId: chart.layoutId, tileId: chart.tileId, layerId }, adding: null });
export const closeIndicatorSettings = () => patch(indicatorUiStore, { editing: null });

export function isChart(ref: ChartRef | null, chart: ChartRef): boolean {
  return ref !== null && ref.layoutId === chart.layoutId && ref.tileId === chart.tileId;
}
