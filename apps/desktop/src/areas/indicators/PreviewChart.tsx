import { createChart, IndicatorLayer, type ChartApi } from '@tessera/chart';
import type { IndicatorSeries, IndicatorSpec, Timeframe } from '@tessera/protocol';
import { useEffect, useRef } from 'react';
import { useClock } from '../../app/clock.ts';
import { ChartFeed } from '../../chart/feed.ts';
import {
  drawnAsIndicator,
  engineStyle,
  indicatorLabel,
  resolveIndicator,
  themeSwatches,
} from '../../chart/indicators.ts';
import { engineObjects, objectInk } from '../../chart/layers/custom.ts';
import { previewIndicator } from '../../chart/layers/indicators.ts';
import { chartThemeStore } from '../../chart/chartTheme.ts';
import { seriesValuesOf } from '../../market/studies.ts';
import { PREVIEW_BARS } from './model.ts';
import { read } from '../../app/store.ts';

export function PreviewChart({
  instrument,
  tf,
  series = null,
  builtin = null,
}: {
  instrument: string;
  tf: Timeframe;
  series?: IndicatorSeries | null;
  builtin?: IndicatorSpec | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const clock = useClock();
  const chartRef = useRef<ChartApi | null>(null);
  const feedRef = useRef<ChartFeed | null>(null);
  const drawn = useRef<{ layer: IndicatorLayer; key: string } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = createChart(el, {
      theme: read(chartThemeStore).theme,
      now: clock.now,
      legend: { title: '' },
      initialBars: 120,
      rightPadBars: 4,
      volumePane: 0,
    });
    const feed = new ChartFeed(chart, { newest: PREVIEW_BARS });
    chartRef.current = chart;
    feedRef.current = feed;
    return () => {
      feed.dispose();
      chart.destroy();
      chartRef.current = null;
      feedRef.current = null;
      drawn.current = null;
    };
  }, [clock]);

  useEffect(() => {
    feedRef.current?.load(instrument, tf, null);
  }, [instrument, tf]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !builtin || !drawnAsIndicator(builtin)) return;
    return previewIndicator(chart, builtin, instrument, tf);
  }, [builtin, instrument, tf]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!series) {
      if (drawn.current) chart.removeLayer(drawn.current.layer.id);
      drawn.current = null;
      return;
    }
    const spec = series.spec;
    const settings = resolveIndicator(spec, { inputs: series.inputs });
    const key = JSON.stringify(spec);
    if (drawn.current?.key !== key) {
      if (drawn.current) chart.removeLayer(drawn.current.layer.id);
      const layer = new IndicatorLayer({
        id: 'preview',
        def: spec,
        inputs: settings.inputs,
        style: engineStyle(spec, settings),
        label: indicatorLabel(spec, settings.inputs),
        z: spec.placement === 'pane' ? 10 : 6,
        legend: true,
        ...(settings.height === null ? {} : { paneHeight: Math.max(settings.height, 0.35) }),
      });
      chart.addLayer(layer);
      drawn.current = { layer, key };
    }
    const { layer } = drawn.current;
    layer.setValues(seriesValuesOf(series));
    const palette = themeSwatches(spec.kind);
    const style = engineStyle(spec, settings, { palette });
    layer.setStyle(style, indicatorLabel(spec, settings.inputs));
    layer.setObjects(engineObjects(series.objects, objectInk(spec, style, false, palette), palette));
    layer.setInputs(settings.inputs);
  }, [series]);

  return (
    <div className="ia-preview">
      <div ref={host} className="ia-preview-chart" />
    </div>
  );
}
