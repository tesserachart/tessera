import { createCanvas } from '@napi-rs/canvas';
import {
  createHeadlessChart,
  FootprintLayer,
  IndicatorLayer,
  SeriesValues,
  type Bar,
  type HeadlessChart,
} from '@tessera/chart';
import { INDICATOR_SPECS, type ChartLayer } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { engineStyle, resolveIndicator } from '../src/chart/indicators.ts';
import { indicatorLayerId } from '../src/chart/layers/index.ts';
import { IndicatorLegend } from '../src/chart/settings/IndicatorLegend.tsx';
import { fakeRuntime } from './support/fakeRuntime.ts';

const T0 = Date.parse('2026-10-02T09:30:00-04:00');
const MIN = 60_000;

const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
  t: T0 + i * MIN,
  o: 100,
  h: 102,
  l: 99,
  c: 101,
  v: 10,
}));

const layer = (id: string, kind: string): ChartLayer => ({
  id,
  kind,
  params: {},
  visible: true,
  namespace: 'user',
  sessionId: null,
});

let chart: HeadlessChart | null = null;

function mount(layers: ChartLayer[]) {
  fakeRuntime({});
  chart = createHeadlessChart({
    width: 1200,
    height: 700,
    createCanvas: (w, h) => createCanvas(w, h),
    timeframeMs: MIN,
    now: () => T0 + 40 * MIN,
  });
  chart.setData('main', bars);
  render(
    <TooltipProvider>
      <IndicatorLegend chart={chart} layoutId="l1" tileId="c1" layers={layers} precision={2} />
    </TooltipProvider>,
  );
  return chart;
}

const skeletons = () => document.querySelectorAll('.ind-lg-skel');
const redraw = (c: HeadlessChart) => act(() => c.render(true));

afterEach(() => {
  cleanup();
  chart?.destroy();
  chart = null;
  document.body.innerHTML = '';
});

describe('the legend while a study reads', () => {
  it('shows one static skeleton in an order-flow row while it reads, then the values, and no words, even over a gap', () => {
    const c = mount([layer('fp-1', 'footprint')]);
    const fp = new FootprintLayer({ id: indicatorLayerId('fp-1') });
    c.addLayer(fp);
    fp.state.read(true);
    fp.setGaps([{ from: -Infinity, to: Infinity }]);
    redraw(c);
    expect(skeletons()).toHaveLength(1);
    const row = document.querySelector('[data-layer="fp-1"]')!;
    expect(skeletons()[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(skeletons()[0]!.textContent).toBe('');
    expect(row.querySelector('.vals')!.textContent).toBe('');

    fp.state.read(false);
    fp.noteChanged();
    redraw(c);
    expect(skeletons()).toHaveLength(0);
    expect(row.querySelector('.vals')!.textContent).toBe('');
  });

  it('shows the skeleton in a plain indicator row until its first answer', () => {
    const spec = INDICATOR_SPECS.find((s) => s.kind === 'vwap')!;
    const settings = resolveIndicator(spec, {});
    const c = mount([layer('vwap-1', 'vwap')]);
    const vwap = new IndicatorLayer({
      id: indicatorLayerId('vwap-1'),
      def: spec,
      inputs: settings.inputs,
      style: engineStyle(spec, settings),
      label: 'VWAP',
      legend: false,
    });
    c.addLayer(vwap);
    vwap.setReading(true);
    redraw(c);
    expect(skeletons()).toHaveLength(1);

    vwap.setReading(false);
    vwap.setValues(
      (() => {
        const values = new SeriesValues();
        values.replaceAll(
          Float64Array.from(bars, (b) => b.t),
          { vwap: Float64Array.from(bars, () => 100.5) },
        );
        return values;
      })(),
    );
    redraw(c);
    expect(skeletons()).toHaveLength(0);
    expect(document.querySelector('[data-layer="vwap-1"] .vals')!.textContent).toContain('100.50');
  });

  it('shows no skeleton for a hidden study', () => {
    const c = mount([{ ...layer('fp-1', 'footprint'), visible: false }]);
    const fp = new FootprintLayer({ id: indicatorLayerId('fp-1') });
    c.addLayer(fp);
    fp.state.read(true);
    redraw(c);
    expect(skeletons()).toHaveLength(0);
  });
});
