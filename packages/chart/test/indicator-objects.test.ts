import { describe, expect, it, vi } from 'vitest';
import { IndicatorLayer, type IndicatorDef, type IndicatorObjectsDef, type IndicatorStyle } from '../src/index.ts';
import { equityBars, headless, valuesOf } from './fixtures.ts';

interface Sink {
  fillText(text: string, x: number, y: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

const SESSIONS: IndicatorDef = {
  kind: 'custom',
  short: 'Sessions',
  placement: 'overlay',
  plots: [],
  fills: [],
  sessionReset: false,
  format: 'price',
};

const EMA: IndicatorDef = {
  kind: 'ema',
  short: 'EMA',
  placement: 'overlay',
  plots: [{ key: 'ma', label: 'MA', kind: 'line' }],
  fills: [],
  sessionReset: false,
  format: 'price',
};

const BANDS: IndicatorDef = {
  kind: 'bollinger',
  short: 'BB',
  placement: 'overlay',
  plots: [
    { key: 'upper', label: 'Upper', kind: 'line' },
    { key: 'lower', label: 'Lower', kind: 'line' },
  ],
  fills: [],
  sessionReset: false,
  format: 'price',
};

const line = (color: string) => ({ color, width: 1, line: 'solid' as const, opacity: 1, visible: true });

function constant(keys: readonly string[], value: (key: string) => number) {
  return valuesOf(equityBars(2), Object.fromEntries(keys.map((k) => [k, () => value(k)])));
}

function setup() {
  const chart = headless({ volumePane: 0 });
  const bars = equityBars(2);
  chart.setData('main', bars);
  const ctx = chart.canvases.main.getContext('2d') as Sink;
  return { chart, bars, ctx };
}

describe('objects an indicator draws', () => {
  it('draws lines with their words in their colour, labels and boxes, in its layer', () => {
    const { chart, bars, ctx } = setup();
    const last = bars.length - 1;
    const high = Math.max(...bars.slice(0, 40).map((b) => b.h));
    const objects: IndicatorObjectsDef = {
      lines: [
        {
          t1: bars[20]!.t,
          p1: high,
          t2: null,
          p2: high,
          color: '#9d8cf2',
          width: 1,
          line: 'solid',
          extend: 'none',
          label: { text: 'Asia H', at: 'end', side: 'above', color: '#9d8cf2' },
        },
      ],
      labels: [{ t: bars[60]!.t, p: bars[60]!.l, text: 'Low', color: '#e0a64a', size: 'large', side: 'below' }],
      boxes: [
        {
          t1: bars[10]!.t,
          p1: bars[10]!.h,
          t2: bars[30]!.t,
          p2: bars[10]!.l,
          color: '#5aa7e0',
          width: 1,
          line: 'solid',
          fill: '#5aa7e0',
          opacity: 0.2,
          extend: 'none',
          label: { text: 'Range', at: 'start', side: 'above', color: '#5aa7e0' },
        },
      ],
    };
    const layer = new IndicatorLayer({
      id: 'sessions',
      def: SESSIONS,
      inputs: {},
      style: { plots: {}, fills: {} },
      label: 'Sessions',
      objects,
    });
    chart.addLayer(layer);
    const text = vi.spyOn(ctx, 'fillText');
    const to = vi.spyOn(ctx, 'lineTo');
    const rect = vi.spyOn(ctx, 'fillRect');
    chart.render(true);
    const c = chart.coords();
    const xEnd = c.xOfTime(bars[last]!.t)!;
    const yHigh = c.yOfPrice(high);
    const word = (w: string) => text.mock.calls.find((call) => call[0] === w);
    expect(to.mock.calls.some(([x, y]) => Math.abs(x - xEnd) < 0.01 && Math.abs(y - yHigh) < 1)).toBe(true);
    const asia = word('Asia H')!;
    expect(asia[2]).toBeLessThan(yHigh);
    expect(asia[1]).toBeLessThan(xEnd);
    expect(asia[1]).toBeGreaterThan(c.xOfTime(bars[20]!.t)!);
    expect(word('Low')![2]).toBeGreaterThan(c.yOfPrice(bars[60]!.l));
    expect(word('Range')).toBeTruthy();
    const x10 = c.xOfTime(bars[10]!.t)!;
    expect(rect.mock.calls.some(([x, , w]) => Math.abs(x - x10) < 0.01 && w > 0)).toBe(true);

    text.mockClear();
    layer.setObjects({ lines: [], labels: [{ ...objects.labels[0]!, text: 'Moved' }], boxes: [] });
    chart.render(true);
    expect(word('Moved')).toBeTruthy();
    expect(word('Asia H')).toBeUndefined();
    text.mockClear();
    chart.setLayerVisible('sessions', false);
    chart.render(true);
    expect(word('Moved')).toBeUndefined();
    chart.destroy();
  });

  it('extends a line to the edge and keeps a frozen one where it ended', () => {
    const { chart, bars, ctx } = setup();
    const p = bars[5]!.h;
    const base = {
      p1: p,
      p2: p,
      color: '#fff',
      width: 1,
      line: 'dash' as const,
      label: null,
    };
    chart.addLayer(
      new IndicatorLayer({
        id: 'x',
        def: SESSIONS,
        inputs: {},
        style: { plots: {}, fills: {} },
        label: 'x',
        objects: {
          lines: [
            { ...base, t1: bars[5]!.t, t2: bars[50]!.t, extend: 'none' },
            { ...base, t1: bars[5]!.t, t2: bars[8]!.t, extend: 'right' },
          ],
          labels: [],
          boxes: [],
        },
      }),
    );
    const to = vi.spyOn(ctx, 'lineTo');
    chart.render(true);
    const c = chart.coords();
    const xs = to.mock.calls.map(([x]) => x);
    expect(xs.some((x) => Math.abs(x - c.xOfTime(bars[50]!.t)!) < 0.01)).toBe(true);
    expect(xs.some((x) => Math.abs(x - (c.plot.x + c.plot.w)) < 0.01)).toBe(true);
    chart.destroy();
  });
});

describe('words of lines ending together', () => {
  it('step apart instead of printing over each other', () => {
    const { chart, bars, ctx } = setup();
    const p = bars[40]!.h;
    const level = (text: string, price: number) => ({
      t1: bars[10]!.t,
      p1: price,
      t2: bars[50]!.t,
      p2: price,
      color: '#fff',
      width: 1,
      line: 'solid' as const,
      extend: 'none' as const,
      label: { text, at: 'end' as const, side: 'above' as const, color: '#fff' },
    });
    chart.addLayer(
      new IndicatorLayer({
        id: 'pd',
        def: SESSIONS,
        inputs: {},
        style: { plots: {}, fills: {} },
        label: 'pd',
        objects: { lines: [level('PDH', p), level('London H', p + 0.01)], labels: [], boxes: [] },
      }),
    );
    const text = vi.spyOn(ctx, 'fillText');
    chart.render(true);
    const y = (w: string) => text.mock.calls.find((c) => c[0] === w)![2];
    expect(Math.abs(y('PDH') - y('London H'))).toBeGreaterThanOrEqual(12);
    chart.destroy();
  });
});

describe('labels on an indicator’s lines', () => {
  function ema(style: IndicatorStyle) {
    return new IndicatorLayer({
      id: 'ema',
      def: EMA,
      inputs: {},
      style,
      label: 'EMA 20',
      values: constant(['ma'], () => 487.25),
    });
  }

  it('names a line at its right end, with its value when asked, and tags its scale when on', () => {
    const { chart, ctx } = setup();
    const layer = ema({ plots: { ma: line('#e0a64a') }, fills: {} });
    chart.addLayer(layer);
    const text = vi.spyOn(ctx, 'fillText');
    chart.render(true);
    const words = () => text.mock.calls.map((c) => c[0]);
    const plotW = chart.coords().plot.w;
    const axis = () => text.mock.calls.filter((c) => c[1] > plotW).map((c) => c[0]);
    expect(words()).not.toContain('EMA 20');
    expect(axis()).not.toContain('487.25');

    text.mockClear();
    layer.setStyle({
      plots: { ma: line('#e0a64a') },
      fills: {},
      labels: { priceScale: true, name: true, value: false },
    });
    chart.render(true);
    const name = text.mock.calls.find((c) => c[0] === 'EMA 20')!;
    expect(name).toBeTruthy();
    expect(name[2]).toBeCloseTo(chart.coords().yOfPrice(487.25), 0);
    expect(axis()).toContain('487.25');

    text.mockClear();
    layer.setStyle({
      plots: { ma: line('#e0a64a') },
      fills: {},
      labels: { priceScale: false, name: true, value: true },
    });
    chart.render(true);
    expect(words()).toContain('EMA 20 487.25');
    expect(axis()).not.toContain('487.25');
    chart.destroy();
  });

  it('names each of several lines by its plot, apart from each other', () => {
    const { chart, ctx } = setup();
    chart.addLayer(
      new IndicatorLayer({
        id: 'bb',
        def: BANDS,
        inputs: {},
        style: {
          plots: { upper: line('#5aa7e0'), lower: line('#5aa7e0') },
          fills: {},
          labels: { priceScale: false, name: true, value: false },
        },
        label: 'BB 20 2',
        values: constant(['upper', 'lower'], (k) => (k === 'upper' ? 487.26 : 487.25)),
      }),
    );
    const text = vi.spyOn(ctx, 'fillText');
    chart.render(true);
    const upper = text.mock.calls.find((c) => c[0] === 'Upper');
    const lower = text.mock.calls.find((c) => c[0] === 'Lower');
    expect(upper && lower).toBeTruthy();
    expect(Math.abs(upper![2] - lower![2])).toBeGreaterThanOrEqual(12);
    chart.destroy();
  });
});
