import { footprintRowTicks, StackedImbalanceLayer } from '@tessera/chart';
import type { IndicatorSettings } from '../../indicators.ts';
import { flowLayerId, followFootprints, registerFlowView, rowTicksOf } from './common.ts';

function stackedImbalanceOptions(s: IndicatorSettings) {
  const i = s.inputs;
  return {
    rowTicks: rowTicksOf(i.rowTicks),
    ratio: Number(i.ratio),
    minVolume: Number(i.minVolume),
    minDifference: Number(i.minDifference),
    includeZero: i.includeZero === true,
    stackRows: Number(i.stackRows),
    tested: i.tested !== false,
  };
}

registerFlowView('stacked_imbalance', (model) => {
  const layer = new StackedImbalanceLayer({ id: flowLayerId(model), owner: model.sessionId });
  return {
    layers: [layer],
    apply(settings, _m, c) {
      layer.setOptions({ ...stackedImbalanceOptions(settings), minRowTicks: footprintRowTicks(c.spec?.root) });
    },
    link(flow, c) {
      return followFootprints(layer, flow, c);
    },
  };
});
