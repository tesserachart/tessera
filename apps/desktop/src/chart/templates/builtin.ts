import { updateChart } from '../../workspace/controller.ts';
import type { ChartRef } from '../settings/store.ts';
import { withOrderFlow } from './orderFlow.ts';

export { isOrderFlow, withOrderFlow } from './orderFlow.ts';

export async function applyOrderFlow(chart: ChartRef): Promise<void> {
  await updateChart(chart.layoutId, chart.tileId, (c) => ({ ...c, layers: withOrderFlow(c.layers) }));
}
