import { IndicatorLayer, SeriesValues, type ChartApi, type InputValue } from '@tessera/chart';
import {
  INDICATOR_SPECS,
  type ChartLayer,
  type DrawnLayerKind,
  type IndicatorObjects,
  type IndicatorSpec,
  type Timeframe,
} from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { studyAsk, StudyLink, type StudyView } from '../../market/studies.ts';
import { drawnAsIndicator, engineStyle, indicatorLabel, resolveIndicator } from '../indicators.ts';
import { engineObjects } from './custom.ts';
import { registerLayerFactory, type LayerBinding, type LayerContext } from './registry.ts';

export function indicatorLayerId(layerId: string): string {
  return `model:${layerId}`;
}

export function valuesView(layer: () => IndicatorLayer | null): StudyView {
  return {
    linked(source) {
      layer()?.setValues(source?.values ?? new SeriesValues());
      layer()?.setReading(source?.reading ?? false);
    },
    changed(source, change) {
      layer()?.valuesChanged(change);
      layer()?.setReading(source.reading);
    },
  };
}

function indicatorBinding(spec: IndicatorSpec, ctx: LayerContext): LayerBinding {
  const { chart } = ctx;
  let drawn: { layer: IndicatorLayer; inputsKey: string } | null = null;
  let painted: IndicatorObjects | null = null;
  const paint = (objects: IndicatorObjects | null) => {
    painted = objects;
    if (drawn) drawn.layer.setObjects(engineObjects(objects, TOKENS.t2));
  };
  const values = valuesView(() => drawn?.layer ?? null);
  const study = new StudyLink({
    linked(source) {
      values.linked(source);
      const objects = source?.objects ?? null;
      if (objects !== painted) paint(objects);
    },
    changed(source, change) {
      values.changed(source, change);
      if (source.objects !== painted) paint(source.objects);
    },
  });
  return {
    update(model: ChartLayer, next: LayerContext, order: number) {
      const settings = resolveIndicator(spec, model.params);
      const finalStyle = engineStyle(spec, settings, { agent: model.namespace === 'agent' });
      const inputs: Record<string, InputValue> = settings.inputs;
      const inputsKey = JSON.stringify(inputs);
      const label = indicatorLabel(spec, inputs);
      const height = settings.height ?? undefined;
      if (!drawn) {
        const layer = new IndicatorLayer({
          id: indicatorLayerId(model.id),
          def: spec,
          inputs,
          style: finalStyle,
          label,
          z: spec.kind === 'vwap' ? 5 : spec.placement === 'pane' ? 10 : 6,
          owner: model.sessionId,
          legend: false,
          ...(height !== undefined ? { paneHeight: height } : {}),
          paneOrder: order,
        });
        chart.addLayer(layer);
        drawn = { layer, inputsKey };
      } else {
        if (drawn.inputsKey !== inputsKey) {
          drawn.layer.setInputs(inputs);
          drawn.inputsKey = inputsKey;
        }
        drawn.layer.setStyle(finalStyle, label);
        drawn.layer.setPaneHeight(height);
        drawn.layer.setPaneOrder(order);
      }
      chart.setLayerVisible(drawn.layer.id, model.visible);
      study.follow(model.visible ? studyAsk(next, { indicator: spec.kind, inputs }) : null);
    },
    dispose() {
      study.dispose();
      if (drawn) chart.removeLayer(drawn.layer.id);
      drawn = null;
    },
  };
}

export function previewIndicator(chart: ChartApi, spec: IndicatorSpec, instrument: string, tf: Timeframe): () => void {
  const settings = resolveIndicator(spec, {});
  const layer = new IndicatorLayer({
    id: 'preview-builtin',
    def: spec,
    inputs: settings.inputs,
    style: engineStyle(spec, settings),
    label: indicatorLabel(spec, settings.inputs),
    z: spec.placement === 'pane' ? 10 : 6,
    legend: true,
    ...(settings.height === null ? {} : { paneHeight: Math.max(settings.height, 0.35) }),
  });
  const study = new StudyLink(valuesView(() => layer));
  chart.addLayer(layer);
  study.follow({ instrument, tf, indicator: spec.kind, inputs: settings.inputs });
  return () => {
    study.dispose();
    chart.removeLayer(layer.id);
  };
}

for (const spec of INDICATOR_SPECS) {
  if (!drawnAsIndicator(spec)) continue;
  registerLayerFactory(spec.kind as DrawnLayerKind, {
    label: (layer) => indicatorLabel(spec, resolveIndicator(spec, layer.params).inputs),
    create: (_layer, ctx) => indicatorBinding(spec, ctx),
  });
}
