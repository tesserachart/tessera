import { aggressorNoteOf, DeltaLayer, SeriesValues, type DeltaStyle } from '@tessera/chart';
import { INDICATOR_SPECS, type IndicatorSpec } from '@tessera/protocol';
import { studyAsk, StudyLink, type StudyAsk, type StudyChart, type StudySource } from '../../../market/studies.ts';
import { engineStyle, resolveIndicator, type IndicatorSettings } from '../../indicators.ts';
import { DEFAULT_DAYS_TO_LOAD } from '../../../market/flow/hub.ts';
import { daysToLoadOf, flowLayerId, noteFrom, registerFlowView } from './common.ts';

const SPEC: IndicatorSpec = INDICATOR_SPECS.find((s) => s.kind === 'delta')!;

export function deltaOptions(s: IndicatorSettings) {
  const i = s.inputs;
  return {
    mode: i.mode === 'bar' ? ('bar' as const) : ('cumulative' as const),
    style:
      i.style === 'line' ? ('line' as const) : i.style === 'histogram' ? ('histogram' as const) : ('candles' as const),
    reset: i.reset === 'chart' ? ('chart' as const) : ('session' as const),
    barStats: i.barStats === true,
    highlight: typeof i.highlight === 'number' ? i.highlight : 0,
    divergence: i.divergence === true,
  };
}

export function cvdAsk(
  chart: StudyChart,
  reset: 'session' | 'chart',
  daysToLoad = DEFAULT_DAYS_TO_LOAD,
): StudyAsk | null {
  return studyAsk(chart, { indicator: 'delta', inputs: { reset, daysToLoad } });
}

function styleOf(s: IndicatorSettings): DeltaStyle {
  const st = engineStyle(SPEC, s);
  const plot = (k: string) => {
    const p = st.plots[k]!;
    return { ...p, downColor: p.downColor ?? null };
  };
  return { zero: plot('zero'), delta: plot('delta'), cvd: plot('cvd') };
}

registerFlowView('delta', (model) => {
  const layer = new DeltaLayer({
    id: flowLayerId(model),
    owner: model.sessionId,
    style: styleOf(resolveIndicator(SPEC, model.params)),
  });
  return {
    layers: [layer],
    apply(settings, _model, _ctx, order) {
      layer.setOptions(deltaOptions(settings), styleOf(settings));
      layer.setPaneHeight(settings.height ?? undefined);
      layer.setPaneOrder(order);
    },
    linkKey: (settings, c) =>
      JSON.stringify([deltaOptions(settings).reset, c.printBars ?? null, daysToLoadOf(settings)]),
    link(_flow, c, settings) {
      const note = (source: StudySource | null) => {
        noteFrom(layer.state, [
          source && {
            reading: source.reading,
            error: source.status.error?.message ?? null,
            loaded: source.status.loaded && { loaded: source.status.loaded, filling: source.status.filling },
          },
        ]);
        layer.state.aggressor = aggressorNoteOf(source?.status.aggressorSource);
        layer.noteChanged();
      };
      const study = new StudyLink({
        linked(source) {
          layer.setValues(source?.values ?? new SeriesValues());
          note(source);
        },
        changed(source, change) {
          layer.valuesChanged(change);
          note(source);
        },
      });
      study.follow(cvdAsk(c, deltaOptions(settings).reset, daysToLoadOf(settings)));
      return () => study.dispose();
    },
  };
});
