import {
  FootprintLayer,
  footprintRowTicks,
  type FootprintMaxLevel,
  type FootprintMode,
  type FootprintTint,
} from '@tessera/chart';
import { StudyLink } from '../../../market/studies.ts';
import type { IndicatorSettings } from '../../indicators.ts';
import { daysToLoadOf, flowLayerId, followFootprints, registerFlowView, rowTicksOf } from './common.ts';
import { cvdAsk } from './delta.ts';

export function footprintOptions(s: IndicatorSettings) {
  const i = s.inputs;
  return {
    mode: String(i.mode) as FootprintMode,
    tint: String(i.tint) as FootprintTint,
    rowTicks: rowTicksOf(i.rowTicks),
    dimBelow: Number(i.dimBelow ?? 0),
    maxLevel: String(i.maxLevel ?? 'off') as FootprintMaxLevel,
    ratio: Number(i.ratio),
    minVolume: Number(i.minVolume),
    minDifference: Number(i.minDifference),
    includeZero: i.includeZero === true,
    stackRows: Number(i.stackRows),
    extendZones: i.extendZones === true,
    poc: i.poc === true,
    deltaPoc: i.deltaPoc !== false,
    valueArea: i.valueArea !== false,
    unfinished: i.unfinished !== false,
    stats: i.stats === true,
  };
}

registerFlowView('footprint', (model) => {
  const layer = new FootprintLayer({ id: flowLayerId(model), owner: model.sessionId });
  const cvd = new StudyLink({
    linked: (source) => layer.setCvd(source?.values ?? null),
    changed: () => layer.dataChanged(),
  });
  return {
    layers: [layer],
    apply(settings, m, c) {
      const options = footprintOptions(settings);
      layer.setOptions({ ...options, minRowTicks: footprintRowTicks(c.spec?.root) });
      cvd.follow(options.stats && m.visible ? cvdAsk(c, 'session') : null);
    },
    dispose() {
      cvd.dispose();
    },
    linkKey: (settings) => String(daysToLoadOf(settings)),
    link(flow, c, settings) {
      return followFootprints(layer, flow, c, daysToLoadOf(settings));
    },
  };
});
