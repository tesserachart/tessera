import type { ChartLayer, LevelsLayerParams } from '@tessera/protocol';
import { levelsForLayer } from '../levels.ts';
import { paramsOf, registerLayerFactory } from './registry.ts';

registerLayerFactory('levels', {
  label: (layer: ChartLayer) => {
    const p = paramsOf<LevelsLayerParams>(layer);
    return p.vendor ? [p.vendor, p.package].filter(Boolean).join(' · ') : (p.group ?? 'Levels');
  },
  create: (layer, ctx) => {
    const id = layer.id;
    return {
      update(l, c) {
        c.levelsSink.set(id, l.visible ? levelsForLayer(l, c.levels) : []);
      },
      dispose() {
        ctx.levelsSink.remove(id);
      },
    };
  },
});
