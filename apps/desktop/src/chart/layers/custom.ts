import {
  IndicatorLayer,
  NO_OBJECTS,
  type IndicatorObjectsDef,
  type IndicatorStyle,
  type ObjectTextDef,
} from '@tessera/chart';
import {
  normalizeEpochMs,
  type ChartLayer,
  type IndicatorObjects,
  type IndicatorSpec,
  type ObjectText,
} from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { CUSTOM_KIND, customRef, retainCatalog, setProblem, customStore } from '../../indicators/custom.ts';
import { studyAsk, StudyLink, type StudySource } from '../../market/studies.ts';
import {
  colorOf,
  engineStyle,
  indicatorLabel,
  layerSpec,
  resolveIndicator,
  themeSwatches,
  type SwatchPalette,
} from '../indicators.ts';
import { indicatorLayerId, valuesView } from './indicators.ts';
import { registerLayerFactory, type LayerBinding, type LayerContext } from './registry.ts';
import { read, watch } from '../../app/store.ts';

export function objectInk(spec: IndicatorSpec, style: IndicatorStyle, agent: boolean, palette: SwatchPalette): string {
  if (agent) return palette.aqua ?? TOKENS.aqua;
  const first = spec.plots.find((p) => p.kind === 'line');
  return (first && style.plots[first.key]?.color) ?? palette.t2 ?? TOKENS.t2;
}

export function engineObjects(
  o: IndicatorObjects | null,
  ink: string,
  palette: SwatchPalette = themeSwatches(),
): IndicatorObjectsDef {
  if (!o) return NO_OBJECTS;
  const color = (c: string | null, fallback = ink) => (c ? colorOf(c, palette) : fallback);
  const text = (t: ObjectText | null, line: string): ObjectTextDef | null =>
    t ? { text: t.text, at: t.at, side: t.side, color: color(t.color, line) } : null;
  return {
    lines: o.lines.map((l) => {
      const c = color(l.color);
      return {
        t1: normalizeEpochMs(l.time1),
        p1: l.price1,
        t2: l.time2 === null ? null : normalizeEpochMs(l.time2),
        p2: l.price2,
        color: c,
        width: l.width,
        line: l.line,
        extend: l.extend,
        label: text(l.label, c),
      };
    }),
    labels: o.labels.map((l) => ({
      t: normalizeEpochMs(l.time),
      p: l.price,
      text: l.text,
      color: color(l.color),
      size: l.size,
      side: l.side,
    })),
    boxes: o.boxes.map((b) => {
      const c = color(b.color);
      return {
        t1: normalizeEpochMs(b.time1),
        p1: b.price1,
        t2: b.time2 === null ? null : normalizeEpochMs(b.time2),
        p2: b.price2,
        color: c,
        width: b.width,
        line: b.line,
        fill: color(b.fill, c),
        opacity: b.opacity,
        extend: b.extend,
        label: text(b.label, c),
      };
    }),
  };
}

const lineLabels = new Map<string, readonly string[]>();

export function drawnLineLabels(layerId: string): readonly string[] {
  return lineLabels.get(layerId) ?? [];
}

function labelsOf(objects: IndicatorObjects | null): string[] {
  const out = new Set<string>();
  for (const l of objects?.lines ?? []) if (l.label?.text) out.add(l.label.text);
  return [...out];
}

function customBinding(first: LayerContext): LayerBinding {
  const { chart } = first;
  const release = retainCatalog();
  let ctx = first;
  let model: ChartLayer | null = null;
  let order = 0;
  let drawn: { layer: IndicatorLayer; specKey: string; inputsKey: string } | null = null;
  let ink: string = TOKENS.t2;
  let painted: IndicatorObjects | null = null;
  const paintObjects = (objects: IndicatorObjects | null) => {
    painted = objects;
    drawn?.layer.setObjects(engineObjects(objects, ink));
  };
  const report = (source: StudySource | null) => {
    if (!model) return;
    setProblem(model.id, source?.status.error ?? null);
    lineLabels.set(model.id, labelsOf(source?.objects ?? null));
  };
  const values = valuesView(() => drawn?.layer ?? null);
  const study = new StudyLink({
    linked(source) {
      values.linked(source);
      paintObjects(source?.objects ?? null);
      report(source);
    },
    changed(source, change) {
      values.changed(source, change);
      if (source.objects !== painted) paintObjects(source.objects);
      report(source);
    },
  });
  const undraw = () => {
    if (drawn) chart.removeLayer(drawn.layer.id);
    drawn = null;
  };

  const apply = () => {
    const m = model;
    if (!m) return;
    const id = customRef(m.params);
    const spec = layerSpec(m);
    if (!id || !spec) {
      study.follow(null);
      undraw();
      const { loaded } = read(customStore);
      if (loaded || !id)
        setProblem(m.id, {
          message: id ? 'This custom indicator was deleted' : 'No custom indicator named',
          line: null,
        });
      return;
    }
    const settings = resolveIndicator(spec, m.params);
    const agent = m.namespace === 'agent';
    const palette = themeSwatches(spec.kind);
    const style = engineStyle(spec, settings, { agent, palette });
    ink = objectInk(spec, style, agent, palette);
    const inputs = settings.inputs;
    const inputsKey = JSON.stringify(inputs);
    const label = indicatorLabel(spec, inputs);
    const height = settings.height ?? undefined;
    const specKey = JSON.stringify(spec);
    if (drawn?.specKey !== specKey) {
      undraw();
      const held = study.source?.values;
      const layer = new IndicatorLayer({
        id: indicatorLayerId(m.id),
        def: spec,
        inputs,
        style,
        label,
        z: spec.placement === 'pane' ? 10 : 6,
        owner: m.sessionId,
        legend: false,
        ...(held ? { values: held } : {}),
        ...(height !== undefined ? { paneHeight: height } : {}),
        paneOrder: order,
      });
      chart.addLayer(layer);
      drawn = { layer, specKey, inputsKey };
    } else {
      if (drawn.inputsKey !== inputsKey) {
        drawn.layer.setInputs(inputs);
        drawn.inputsKey = inputsKey;
      }
      drawn.layer.setStyle(style, label);
      drawn.layer.setPaneHeight(height);
      drawn.layer.setPaneOrder(order);
    }
    chart.setLayerVisible(drawn.layer.id, m.visible);
    paintObjects(study.source?.objects ?? null);

    const version = (m.params as { version?: unknown } | null)?.version;
    study.follow(
      m.visible ? studyAsk(ctx, { indicator: id, inputs, ...(typeof version === 'number' ? { version } : {}) }) : null,
    );
  };

  const unwatch = watch(customStore, (s, prev) => {
    const id = model ? customRef(model.params) : null;
    if (id && (s.byId[id] !== prev.byId[id] || s.loaded !== prev.loaded)) apply();
  });

  return {
    update(layer: ChartLayer, next: LayerContext, at: number) {
      model = layer;
      ctx = next;
      order = at;
      apply();
    },
    dispose() {
      study.dispose();
      unwatch();
      release();
      undraw();
      if (model) {
        setProblem(model.id, null);
        lineLabels.delete(model.id);
      }
      model = null;
    },
  };
}

registerLayerFactory(CUSTOM_KIND, {
  label: (layer) => {
    const spec = layerSpec(layer);
    return spec ? indicatorLabel(spec, resolveIndicator(spec, layer.params).inputs) : 'Custom indicator';
  },
  create: (_layer, ctx) => customBinding(ctx),
});
