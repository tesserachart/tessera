import { describe, expect, it, vi } from 'vitest';
import {
  IndicatorLayer,
  PANE_LEGEND_INSET,
  type Bar,
  type IndicatorDef,
  LegendLayer,
  type IndicatorStyle,
  type PaneHeight,
  type Layer,
  type RenderContext,
} from '../src/index.ts';
import { equityBars, headless, valuesOf } from './fixtures.ts';

const line = (color: string) => ({ color, width: 1.25, line: 'solid' as const, opacity: 1, visible: true });

const RSI: IndicatorDef = {
  kind: 'rsi',
  short: 'RSI',
  placement: 'pane',
  plots: [
    { key: 'upperBand', label: 'Upper band', kind: 'hline', valueInput: 'upper' },
    { key: 'lowerBand', label: 'Lower band', kind: 'hline', valueInput: 'lower' },
    { key: 'rsi', label: 'RSI', kind: 'line' },
  ],
  fills: [{ key: 'zone', from: 'upperBand', to: 'lowerBand' }],
  range: [0, 100],
  sessionReset: false,
  format: 'number',
};

const MACD: IndicatorDef = {
  kind: 'macd',
  short: 'MACD',
  placement: 'pane',
  plots: [
    { key: 'hist', label: 'Histogram', kind: 'histogram', colorBy: 'sign' },
    { key: 'macd', label: 'MACD', kind: 'line' },
    { key: 'signal', label: 'Signal', kind: 'line' },
  ],
  fills: [],
  sessionReset: false,
  format: 'number',
};

const SMA: IndicatorDef = {
  kind: 'sma',
  short: 'SMA',
  placement: 'overlay',
  plots: [{ key: 'ma', label: 'SMA', kind: 'line' }],
  fills: [],
  sessionReset: false,
  format: 'price',
};

const VOLUME: IndicatorDef = {
  kind: 'volume',
  short: 'Vol',
  placement: 'pane',
  plots: [
    { key: 'volume', label: 'Volume', kind: 'histogram', colorBy: 'direction' },
    { key: 'ma', label: 'Average', kind: 'line' },
  ],
  fills: [],
  sessionReset: false,
  format: 'volume',
};

const RSI_STYLE: IndicatorStyle = {
  plots: { rsi: line('#ff0000'), upperBand: line('#6f7c82'), lowerBand: line('#6f7c82') },
  fills: { zone: { color: '#dcebef', opacity: 0.04, visible: true } },
};
const MACD_STYLE: IndicatorStyle = {
  plots: {
    hist: { ...line('#5fc79c'), downColor: '#ec7b78', opacity: 0.5 },
    macd: line('#dcebef'),
    signal: line('#18849a'),
  },
  fills: {},
};

interface TextSink {
  fillText(text: string, x: number, y: number): void;
}

const rsiOf = (bars: readonly Bar[]) => valuesOf(bars, { rsi: (_b, i) => 50 + 10 * Math.sin(i / 9) });

function rsiLayer(id = 'rsi', paneHeight?: number) {
  return new IndicatorLayer({
    id,
    def: RSI,
    inputs: { length: 14, upper: 70, lower: 30 },
    style: RSI_STYLE,
    label: 'RSI 14',
    values: rsiOf(equityBars(3)),
    ...(paneHeight !== undefined ? { paneHeight } : {}),
  });
}

function macdLayer(id = 'macd') {
  return new IndicatorLayer({ id, def: MACD, inputs: {}, style: MACD_STYLE, label: 'MACD 12 26 9' });
}

function volumeLayer(bars: readonly Bar[] = equityBars(2)) {
  return new IndicatorLayer({
    id: 'vol',
    def: VOLUME,
    inputs: { maLength: 20 },
    style: { plots: { volume: { ...line('#5fc79c'), downColor: '#ec7b78' }, ma: line('#aab6bb') }, fills: {} },
    label: 'Vol',
    values: valuesOf(bars, {
      volume: (b) => b.v,
      ma: (_b, i) => (i < 19 ? Number.NaN : bars.slice(i - 19, i + 1).reduce((sum, b) => sum + b.v, 0) / 20),
    }),
  });
}

function paneAxisWords(chart: ReturnType<typeof headless>): string[] {
  const words: string[] = [];
  for (const canvas of Object.values(chart.canvases)) {
    const ctx = canvas.getContext('2d') as TextSink;
    const fill = ctx.fillText.bind(ctx);
    ctx.fillText = (t, x, y) => {
      if (x > chart.coords().plot.w && y > chart.coords().plot.h) words.push(t);
      fill(t, x, y);
    };
  }
  return words;
}

describe('indicator panes', () => {
  it('stack under the price pane in the order they were added, each with its share', () => {
    const chart = headless({ volumePane: 0.1 });
    chart.setData('main', equityBars(3));
    chart.addLayer(rsiLayer('rsi', 0.2));
    chart.addLayer(macdLayer());
    chart.render();
    const c = chart.coords();
    expect(c.panes.map((p) => p.id)).toEqual(['volume', 'pane:rsi', 'pane:macd']);
    const plotH = c.timeAxis.y;
    const [vol, rsi, macd] = c.panes.map((p) => p.rect);
    expect(vol!.y).toBe(c.plot.h);
    expect(rsi!.y).toBe(vol!.y + vol!.h);
    expect(macd!.y).toBe(rsi!.y + rsi!.h);
    expect(macd!.y + macd!.h).toBe(plotH);
    expect(rsi!.h).toBe(Math.round(plotH * 0.2));
    expect(macd!.h).toBe(Math.round(plotH * 0.16));
    expect(c.volume).toEqual(vol);
    chart.setLayerVisible('rsi', false);
    chart.render();
    expect(chart.coords().panes.map((p) => p.id)).toEqual(['volume', 'pane:macd']);
    expect(chart.coords().plot.h).toBe(c.plot.h + rsi!.h);
    chart.removeLayer('macd');
    chart.render();
    expect(chart.coords().panes.map((p) => p.id)).toEqual(['volume']);
    chart.destroy();
  });

  it('keep the price pane its share, shrinking together and dropping what cannot fit', () => {
    const chart = headless({ volumePane: 0, height: 300 });
    chart.setData('main', equityBars(2));
    for (let k = 0; k < 6; k++) chart.addLayer(rsiLayer(`r${String(k)}`, 0.3));
    chart.render();
    const c = chart.coords();
    const plotH = c.timeAxis.y;
    expect(c.plot.h).toBeGreaterThanOrEqual(Math.floor(plotH * 0.3));
    expect(c.panes.map((p) => p.id)).toEqual(['pane:r0', 'pane:r1', 'pane:r2', 'pane:r3', 'pane:r4']);
    for (const p of c.panes) expect(p.rect.h).toBeGreaterThanOrEqual(36);
    chart.destroy();
  });

  it('draws in its own pane on its own scale: RSI on 0–100, the pointer reads its value', () => {
    const chart = headless({ volumePane: 0 });
    const bars = equityBars(3);
    chart.setData('main', bars);
    const layer = rsiLayer();
    chart.addLayer(layer);
    chart.render();
    const pane = chart.coords().panes[0]!.rect;
    const last = bars.length - 1;
    expect(layer.valueAt('rsi', last)).toBe(50 + 10 * Math.sin(last / 9));
    expect(layer.valueAt('upperBand', 0)).toBe(70);
    const top = Math.max(0.06, PANE_LEGEND_INSET / pane.h);
    const y70 = pane.y + pane.h * (top + (1 - top - 0.06) * (30 / 100));
    chart.engine.pointerMove(300, y70);
    chart.render();
    const st = (chart.engine as unknown as { crosshair: { pane: string; value: number } }).crosshair;
    expect(st.pane).toBe('pane:rsi');
    expect(st.value).toBeCloseTo(70, 0);
    expect(chart.getViewport().priceMax).toBeLessThan(1000);
    chart.destroy();
  });

  it('keeps a bounded oscillator at its top clear of the pane’s legend row', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(3));
    chart.addLayer(rsiLayer('rsi', 0.2));
    chart.render();
    const pane = chart.coords().panes[0]!.rect;
    const engine = chart.engine as unknown as { paneScales: Map<string, { yOf(v: number): number }> };
    const scale = engine.paneScales.get('pane:rsi')!;
    expect(scale.yOf(100)).toBeGreaterThanOrEqual(pane.y + PANE_LEGEND_INSET);
    expect(scale.yOf(0)).toBeLessThan(pane.y + pane.h);
    chart.destroy();
  });

  it('follows live bars, a new bar reading its values once the runtime sends them', () => {
    const chart = headless({ volumePane: 0 });
    const bars = equityBars(2);
    const held = bars.slice(0, -1);
    const values = valuesOf(held, { macd: (b) => b.c - b.o, signal: () => 0, hist: (b) => b.c - b.o });
    chart.setData('main', held);
    const layer = new IndicatorLayer({ id: 'macd', def: MACD, inputs: {}, style: MACD_STYLE, label: 'MACD', values });
    chart.addLayer(layer);
    const b = bars.at(-1)!;
    const last = bars.length - 1;
    chart.update('main', b);
    expect(layer.length).toBe(bars.length);
    expect(layer.valueAt('macd', last)).toBeNaN();
    values.replaceSpan(b.t, b.t, Float64Array.of(b.t), {
      macd: Float64Array.of(1.5),
      signal: Float64Array.of(0.5),
      hist: Float64Array.of(1),
    });
    layer.valuesChanged({ kind: 'span', from: b.t, to: b.t });
    expect(layer.valueAt('macd', last)).toBe(1.5);
    expect(layer.valueAt('hist', last)).toBe(1);
    expect(layer.valueAt('macd', last - 1)).toBe(held.at(-1)!.c - held.at(-1)!.o);
    chart.destroy();
  });

  it('resize by dragging the separator; the pane above trades height and the result is reported', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    chart.addLayer(rsiLayer('rsi', 0.2));
    chart.addLayer(macdLayer());
    chart.render();
    const before = chart.coords().panes.map((p) => ({ ...p.rect }));
    const reported: (readonly PaneHeight[])[] = [];
    chart.on('panes', (p) => reported.push(p));
    const sepY = before[1]!.y;
    expect(chart.engine.cursorAt(300, sepY)).toBe('row-resize');
    chart.engine.pointerDown(300, sepY);
    chart.engine.pointerMove(300, sepY - 30);
    chart.engine.pointerUp(300, sepY - 30);
    chart.render();
    const after = chart.coords().panes.map((p) => p.rect);
    expect(after[1]!.h).toBeCloseTo(before[1]!.h + 30, -1);
    expect(after[0]!.h).toBeCloseTo(before[0]!.h - 30, -1);
    expect(chart.coords().plot.h).toBe(before[0]!.y);
    expect(reported).toHaveLength(1);
    const plotH = chart.coords().timeAxis.y;
    expect(reported[0]!.find((p) => p.id === 'pane:macd')!.height).toBeCloseTo(after[1]!.h / plotH, 6);
    const top = after[0]!.y;
    chart.engine.pointerDown(300, top);
    chart.engine.pointerMove(300, top + 20);
    chart.engine.pointerUp(300, top + 20);
    chart.render();
    expect(chart.coords().plot.h).toBe(top + 20);
    chart.destroy();
  });

  it('report only the two panes a drag traded, and nothing for a press that did not move', () => {
    const chart = headless({ volumePane: 0, height: 400 });
    chart.setData('main', equityBars(2));
    for (const id of ['a', 'b', 'c']) chart.addLayer(rsiLayer(id, 0.3));
    chart.render();
    const reported: (readonly PaneHeight[])[] = [];
    chart.on('panes', (p) => reported.push(p));
    const panes = chart.coords().panes;
    const sepY = panes[2]!.rect.y;
    chart.engine.pointerDown(300, sepY);
    chart.engine.pointerUp(300, sepY);
    expect(reported).toEqual([]);
    chart.engine.pointerDown(300, sepY);
    chart.engine.pointerMove(300, sepY - 10);
    chart.engine.pointerUp(300, sepY - 10);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.map((p) => p.id)).toEqual(['pane:c', 'pane:b']);
    const top = chart.coords().panes[0]!.rect.y;
    chart.engine.pointerDown(300, top);
    chart.engine.pointerMove(300, top + 10);
    chart.engine.pointerUp(300, top + 10);
    expect(reported[1]!.map((p) => p.id)).toEqual(['pane:a']);
    chart.destroy();
  });

  it('stack by the order the app gives them, whatever order they were added in', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    const macd = new IndicatorLayer({
      id: 'macd',
      def: MACD,
      inputs: {},
      style: MACD_STYLE,
      label: 'MACD',
      paneOrder: 1,
    });
    const rsi = new IndicatorLayer({
      id: 'rsi',
      def: RSI,
      inputs: { length: 14, upper: 70, lower: 30 },
      style: RSI_STYLE,
      label: 'RSI 14',
      paneOrder: 2,
    });
    chart.addLayer(rsi);
    chart.addLayer(macd);
    chart.render();
    expect(chart.coords().panes.map((p) => p.id)).toEqual(['pane:macd', 'pane:rsi']);
    rsi.setPaneOrder(0);
    chart.render();
    expect(chart.coords().panes.map((p) => p.id)).toEqual(['pane:rsi', 'pane:macd']);
    chart.destroy();
  });

  it("leave the candles' scale alone when the pointer is on a sub-pane's axis", () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(3));
    chart.addLayer(rsiLayer());
    chart.render();
    const c = chart.coords();
    const pane = c.panes[0]!.rect;
    const x = c.plot.w + 20;
    const y = pane.y + pane.h / 2;
    const before = chart.getViewport();
    expect(chart.engine.cursorAt(x, y)).toBe('default');
    chart.engine.pointerDown(x, y);
    chart.engine.pointerMove(x, y + 60);
    chart.engine.pointerUp(x, y + 60);
    chart.engine.wheel(0, 120, x, y);
    chart.engine.doubleClick(x, y);
    chart.render();
    const after = chart.getViewport();
    expect([after.priceMin, after.priceMax]).toEqual([before.priceMin, before.priceMax]);
    expect(chart.engine.cursorAt(x, c.plot.h / 2)).toBe('ns-resize');
    chart.engine.pointerDown(x, c.plot.h / 2);
    chart.engine.pointerMove(x, c.plot.h / 2 + 60);
    chart.engine.pointerUp(x, c.plot.h / 2 + 60);
    chart.render();
    expect(chart.getViewport().priceMax).not.toBe(before.priceMax);
    chart.destroy();
  });

  it("label a fixed-range pane's axis at its guides, and only there", () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(3));
    chart.addLayer(rsiLayer('rsi', 0.3));
    const words: string[] = [];
    for (const canvas of Object.values(chart.canvases)) {
      const ctx = canvas.getContext('2d') as TextSink;
      const fill = ctx.fillText.bind(ctx);
      ctx.fillText = (t, x, y) => {
        if (x > chart.coords().plot.w && y > chart.coords().plot.h) words.push(t);
        fill(t, x, y);
      };
    }
    chart.render(true);
    expect(words).toContain('70');
    expect(words).toContain('30');
    expect(words).not.toContain('75');
    expect(words).not.toContain('25');
    chart.destroy();
  });

  it('a pane height set on the layer wins over a dragged one', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    const layer = rsiLayer('rsi', 0.2);
    chart.addLayer(layer);
    chart.render();
    const y = chart.coords().panes[0]!.rect.y;
    chart.engine.pointerDown(300, y);
    chart.engine.pointerMove(300, y - 40);
    chart.engine.pointerUp(300, y - 40);
    layer.setPaneHeight(0.25);
    chart.render();
    const c = chart.coords();
    expect(c.panes[0]!.rect.h).toBe(Math.round(c.timeAxis.y * 0.25));
    chart.destroy();
  });

  it('an overlay indicator draws on the price pane and leaves its scale to the candles', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    chart.render();
    const vp = chart.getViewport();
    const layer = new IndicatorLayer({
      id: 'sma',
      def: SMA,
      inputs: { length: 20 },
      style: { plots: { ma: line('#aab6bb') }, fills: {} },
      label: 'SMA 20',
    });
    chart.addLayer(layer);
    chart.render();
    expect(chart.coords().panes).toEqual([]);
    expect(layer.pane).toBe('main');
    expect(chart.getViewport().priceMin).toBe(vp.priceMin);
    expect(chart.getViewport().priceMax).toBe(vp.priceMax);
    chart.destroy();
  });

  it("draws its pane's label unless the app draws its own legend", () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    const own = rsiLayer('own');
    const quiet = new IndicatorLayer({
      id: 'quiet',
      def: RSI,
      inputs: { length: 14, upper: 70, lower: 30 },
      style: RSI_STYLE,
      label: 'RSI 21',
      legend: false,
    });
    chart.addLayer(own);
    chart.addLayer(quiet);
    const ctx = chart.canvases.main.getContext('2d') as TextSink;
    const text = vi.spyOn(ctx, 'fillText');
    chart.render(true);
    const words = text.mock.calls.map((c) => c[0]);
    expect(words).toContain('RSI 14');
    expect(words).not.toContain('RSI 21');
    chart.destroy();
  });

  it('label the volume axis in thousands at every size, as the rest of the app reads volume', () => {
    const axisAt = (peak: number) => {
      const chart = headless({ volumePane: 0 });
      const bars = equityBars(2);
      const most = Math.max(...bars.map((b) => b.v));
      const scaled = bars.map((b) => ({ ...b, v: Math.round((b.v / most) * peak) }));
      chart.setData('main', scaled);
      chart.addLayer(volumeLayer(scaled));
      const words = paneAxisWords(chart);
      chart.render(true);
      chart.destroy();
      return [...new Set(words)];
    };
    expect(axisAt(6_000)).toEqual(['3.72K', '2.5K', '5K']);
    expect(axisAt(1_300)).toEqual(['805', '500', '1.5K']);
    expect(axisAt(24_000)).toEqual(['14.9K', '10K', '20K']);
  });

  it('label no scale once a chart is cleared for another market, until its bars arrive', () => {
    const chart = headless({ volumePane: 0 });
    chart.addLayer(volumeLayer());
    chart.setData('main', equityBars(2, 7, 29_600));
    chart.render(true);
    const onAxes: string[] = [];
    for (const canvas of Object.values(chart.canvases)) {
      const ctx = canvas.getContext('2d') as TextSink;
      const fill = ctx.fillText.bind(ctx);
      ctx.fillText = (text, x, y) => {
        if (x >= chart.coords().priceAxis.x) onAxes.push(text);
        fill(text, x, y);
      };
    }
    chart.setData('main', []);
    chart.render(true);
    expect(onAxes).toEqual([]);

    chart.setData('main', equityBars(2, 7, 5_600));
    chart.render(true);
    expect(onAxes.some((t) => t.startsWith('5,'))).toBe(true);
    expect(onAxes.some((t) => t.startsWith('29,'))).toBe(false);
    chart.destroy();
  });

  it('label no scale and draw no price grid on a chart whose bars have not arrived', () => {
    const chart = headless({ volumePane: 0 });
    chart.addLayer(volumeLayer());
    const onAxes: { text: string; y: number }[] = [];
    for (const canvas of Object.values(chart.canvases)) {
      const ctx = canvas.getContext('2d') as TextSink;
      const fill = ctx.fillText.bind(ctx);
      ctx.fillText = (text, x, y) => {
        if (x >= chart.coords().priceAxis.x) onAxes.push({ text, y });
        fill(text, x, y);
      };
    }
    chart.render(true);
    expect(onAxes.map((w) => w.text)).toEqual([]);
    const { plot } = chart.coords();
    const main = chart.canvases.main.getContext('2d') as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    const column = main.getImageData(Math.round(plot.w * 0.75), 0, 1, plot.h - 2).data;
    expect(column.filter((_, k) => k % 4 === 3 && column[k]! > 0)).toHaveLength(0);

    chart.setData('main', equityBars(2));
    chart.render(true);
    expect(onAxes.filter((w) => w.y < plot.h).length).toBeGreaterThan(2);
    expect(onAxes.filter((w) => w.y > plot.h).length).toBeGreaterThan(1);
    chart.destroy();
  });
});

describe('the legend', () => {
  it('leaves the rows the app reserves between its first row and its second', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    const legend = chart.getLayer('legend', LegendLayer)!;
    legend.extra = () => [{ text: 'Levels', weight: 500 }];
    const ctx = chart.canvases.overlay.getContext('2d') as TextSink;
    const text = vi.spyOn(ctx, 'fillText');
    const yOf = (word: string) => text.mock.calls.find((c) => c[0] === word)?.[2];
    chart.render(true);
    const top = chart.coords().plot.y;
    const at = yOf('Levels')!;
    expect(at - top).toBe(16 + 19);
    text.mockClear();
    legend.reserved = 44;
    chart.setOptions({});
    chart.render(true);
    expect(yOf('Levels')).toBe(at + 44);
    chart.destroy();
  });

  it('says where it drew, its reserved room and last row included, for what floats over the plot', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    const legend = chart.getLayer('legend', LegendLayer)!;
    chart.render(true);
    const plot = chart.coords().plot;
    const one = legend.extent!;
    expect(one.y).toBe(plot.y);
    expect(one.h).toBeGreaterThanOrEqual(16 + 11);
    expect(one.x).toBeGreaterThanOrEqual(plot.x);
    expect(one.x + one.w).toBeLessThanOrEqual(plot.x + plot.w);
    legend.extra = () => [{ text: 'Zeta levels', weight: 500 }];
    chart.setOptions({});
    chart.render(true);
    const two = legend.extent!.h;
    expect(two).toBeGreaterThanOrEqual(16 + 19 + 11);
    legend.reserved = 44;
    chart.setOptions({});
    chart.render(true);
    expect(legend.extent!.h).toBe(two + 44);
    chart.destroy();
  });
});

describe('axis tags of the underlay', () => {
  it('claim their tick label rows on the main surface like the levels’ tags', () => {
    const chart = headless({ volumePane: 0 });
    chart.setData('main', equityBars(2));
    const axisWords = (canvas: keyof typeof chart.canvases) => {
      const ctx = chart.canvases[canvas].getContext('2d') as TextSink;
      return vi.spyOn(ctx, 'fillText');
    };
    let text = axisWords('main');
    chart.render(true);
    const plotW = chart.coords().plot.w;
    const labels = text.mock.calls.filter((c) => c[1] > plotW && c[2] < chart.coords().plot.h);
    const mid = labels[Math.floor(labels.length / 2)]!;
    text.mockRestore();
    let tagPrice = Number.NaN;
    const profile: Layer = {
      id: 'vp',
      kind: 'study',
      surface: 'underlay',
      draw(rc: RenderContext) {
        tagPrice = rc.mainPrice.priceOf(mid[2]);
        rc.addAxisTag({ price: tagPrice, text: 'POC-TAG', style: 'outline', color: '#dcebef', priority: 1 });
      },
    };
    chart.addLayer(profile);
    text = axisWords('main');
    const under = axisWords('underlay');
    chart.render(true);
    const words = text.mock.calls.map((c) => c[0]);
    expect(Number.isFinite(tagPrice)).toBe(true);
    expect(words.some((w) => w.includes('POC-TAG'))).toBe(true);
    expect(under.mock.calls.some((c) => c[0].includes('POC-TAG'))).toBe(false);
    expect(text.mock.calls.some((c) => c[0] === mid[0] && Math.abs(c[2] - mid[2]) < 1)).toBe(false);
    chart.destroy();
  });
});
