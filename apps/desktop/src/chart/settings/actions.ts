import { updateChart } from '../../workspace/controller.ts';
import { addCustomIndicator, addIndicator } from '../indicators.ts';
import { startParams } from '../presets/model.ts';
import { presetsStore } from '../presets/store.ts';
import { type ChartRef, openAdd } from './store.ts';
import { read } from '../../app/store.ts';

export function addToChart(chart: ChartRef, kind: string): void {
  const params = startParams(read(presetsStore), kind);
  void updateChart(chart.layoutId, chart.tileId, (c) => ({
    ...c,
    layers: addIndicator(c.layers, kind, params).layers,
  }));
}

export function addCustomToChart(chart: ChartRef, indicator: string): void {
  const params = startParams(read(presetsStore), indicator);
  void updateChart(chart.layoutId, chart.tileId, (c) => ({
    ...c,
    layers: addCustomIndicator(c.layers, indicator, params).layers,
  }));
}

export function openAddIndicator(chart: ChartRef): void {
  openAdd(chart);
}
