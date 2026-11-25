import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import {
  AnnotationLayer,
  LevelsLayer,
  type FrameEvent,
  LastPriceLayer,
  LegendLayer,
  PriceFormatter,
  type LayerInfo,
} from '../src/index.ts';
import { continuousBars, equityBars, headless, vwapLayer } from './fixtures.ts';

type Ctx = { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };

function pixel(
  chart: ReturnType<typeof headless>,
  surface: 'main' | 'overlay',
  x: number,
  y: number,
): [number, number, number, number] {
  const ctx = chart.canvases[surface].getContext('2d') as Ctx;
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0]!, d[1]!, d[2]!, d[3]!];
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe('ChartEngine (headless)', () => {
  it('renders candles in the theme colours at the coordinates coords() reports', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    chart.render();
    const c = chart.coords();
    const last = bars.length - 1;
    const b = bars[last]!;
    const x = c.xOfIndex(last);
    const yMid = c.yOfPrice((b.o + b.c) / 2);
    const [r, g, bl] = pixel(chart, 'main', x, yMid);
    const expected = hex(b.c >= b.o ? chart.theme.upFill : chart.theme.downFill);
    expect([r, g, bl]).toEqual(expected);
    expect(pixel(chart, 'main', 1198, 698)[3]).toBe(0);
    const shot = chart.snapshot().getContext('2d') as Ctx;
    expect([...shot.getImageData(1198, 698, 1, 1).data.slice(0, 3)]).toEqual(hex(chart.theme.background));
    chart.destroy();
  });

  it('keeps the band the app clears at the plot’s left free of bars, and draws them again once it is gone', () => {
    const candleAt = (clearLeft: number) => {
      const chart = headless({ initialBars: 24 });
      const bars = equityBars(3);
      chart.setData('main', bars);
      chart.setOptions({ clearLeft });
      chart.render(true);
      const c = chart.coords();
      const hits: number[] = [];
      for (let i = c.from; i <= c.to; i++) {
        const b = bars[i]!;
        const x = c.xOfIndex(i);
        if (x < 4 || x > 120) continue;
        const [r, g, bl] = pixel(chart, 'main', x, c.yOfPrice((b.o + b.c) / 2));
        if ([r, g, bl].join() === hex(b.c >= b.o ? chart.theme.upFill : chart.theme.downFill).join()) hits.push(x);
      }
      chart.destroy();
      return hits;
    };
    expect(candleAt(0).some((x) => x < 40)).toBe(true);
    const cleared = candleAt(48);
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((x) => x >= 48)).toBe(true);
  });

  it('draws each bar while at least half of it is right of the cleared band, panning across the band’s edge', () => {
    const chart = headless({ initialBars: 24 });
    const bars = equityBars(3);
    chart.setData('main', bars);
    chart.setLayerVisible('grid', false);
    const band = 100;
    chart.setOptions({ clearLeft: band });
    chart.render(true);
    const start = chart.getViewport().rightEdgeSlot;
    const fill = (i: number) => hex(bars[i]!.c >= bars[i]!.o ? chart.theme.upFill : chart.theme.downFill).join();
    for (let k = 0; k < 10; k++) {
      chart.setViewport({ rightEdgeSlot: start + k / 10 });
      chart.render(true);
      const c = chart.coords();
      const s = c.barSpacing;
      const vol = c.volume!;
      const first = c.from;
      const xFirst = c.xOfIndex(first);
      const yBody = (i: number) => c.yOfPrice((bars[i]!.o + bars[i]!.c) / 2);
      expect(xFirst).toBeGreaterThanOrEqual(band - 1e-6);
      expect(xFirst - s / 2 - band).toBeLessThan(s / 2);
      expect(pixel(chart, 'main', xFirst, yBody(first)).slice(0, 3).join()).toBe(fill(first));
      expect(pixel(chart, 'main', xFirst, vol.y + vol.h - 2)[3]).toBeGreaterThan(0);
      expect(pixel(chart, 'main', band - 2, yBody(first))[3]).toBe(0);
      expect(pixel(chart, 'main', band - 2, vol.y + vol.h - 2)[3]).toBe(0);
      const before = first - 1;
      if (c.xOfIndex(before) + 0.3 * s > band + 1) {
        expect(
          pixel(chart, 'main', band + 1, yBody(before))
            .slice(0, 3)
            .join(),
        ).not.toBe(fill(before));
        expect(pixel(chart, 'main', band + 1, vol.y + vol.h - 2)[3]).toBe(0);
      }
    }
    chart.destroy();
  });

  it('fits the initial view to the last N bars with right padding', () => {
    const chart = headless({ initialBars: 100, rightPadBars: 8 });
    chart.setData('main', equityBars(3));
    chart.render();
    const vp = chart.getViewport();
    expect(vp.to).toBe(233);
    expect(vp.to - vp.from).toBeGreaterThanOrEqual(99);
    expect(vp.to - vp.from).toBeLessThanOrEqual(102);
    expect(vp.following).toBe(true);
    const c = chart.coords();
    expect(c.plot.w - c.xOfIndex(233)).toBeCloseTo(8 * c.barSpacing, 6);
    expect(c.yOfPrice(c.priceOfY(123))).toBeCloseTo(123, 9);
    expect(c.xOfTime(equityBars(3)[200]!.t + 60_000)).toBeCloseTo(c.xOfIndex(200), 9);
    chart.destroy();
  });

  it('incremental update: replaces the forming bar, appends and follows the right edge', () => {
    const chart = headless();
    const bars = equityBars(2);
    chart.setData('main', bars);
    chart.render();
    const before = chart.getViewport();
    const last = bars.at(-1)!;
    chart.update('main', { ...last, h: last.h + 1, c: last.c + 0.5 });
    expect(chart.getSeries()!.length).toBe(bars.length);
    expect(chart.getSeries()!.close[bars.length - 1]).toBe(last.c + 0.5);
    chart.update('main', {
      t: last.t + 300_000,
      o: last.c,
      h: last.c + 0.2,
      l: last.c - 0.1,
      c: last.c + 0.1,
      v: 1000,
    });
    chart.render();
    const after = chart.getViewport();
    expect(after.to).toBe(bars.length);
    expect(after.rightEdgeSlot - before.rightEdgeSlot).toBeCloseTo(1, 9);
    chart.destroy();
  });

  it('does not follow when the user scrolled back', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    chart.render();
    chart.engine.pointerDown(300, 200);
    chart.engine.pointerMove(600, 200);
    chart.engine.pointerUp(600, 200);
    const vp = chart.getViewport();
    expect(vp.following).toBe(false);
    const last = bars.at(-1)!;
    chart.update('main', { t: last.t + 300_000, o: 1, h: 1, l: 1, c: 1, v: 1 });
    expect(chart.getViewport().rightEdgeSlot).toBe(vp.rightEdgeSlot);
    chart.destroy();
  });

  it('wheel zoom keeps a live chart on its last bar, and zooms at the pointer when scrolled back or with Ctrl', () => {
    const bars = equityBars(3);
    const chart = headless();
    chart.setData('main', bars);
    chart.render();
    const live = chart.getViewport();
    expect(live.following).toBe(true);
    chart.engine.wheel(0, -200, 400, 200);
    const zoomed = chart.getViewport();
    expect(zoomed.barSpacing).toBeGreaterThan(live.barSpacing);
    expect(zoomed.following).toBe(true);
    expect(zoomed.rightEdgeSlot).toBe(live.rightEdgeSlot);
    chart.engine.wheel(0, 300, 400, 200);
    expect(chart.getViewport().following).toBe(true);
    chart.update('main', { t: bars.at(-1)!.t + 300_000, o: 1, h: 1, l: 1, c: 1, v: 1 });
    expect(chart.getViewport().toTime).toBe(bars.at(-1)!.t + 300_000);

    const ctrl = chart.coords().indexOfX(400);
    chart.engine.wheel(0, -40, 400, 200, { ctrl: true });
    expect(chart.coords().indexOfX(400)).toBe(ctrl);
    expect(chart.getViewport().following).toBe(false);
    chart.destroy();
  });

  it('wheel zooms around the pointer once scrolled back; axis drag scales price; double-click resets', () => {
    const chart = headless();
    chart.setData('main', equityBars(3));
    chart.render();
    chart.engine.keyDown('ArrowLeft');
    const c0 = chart.coords();
    const anchorIndex = c0.indexOfX(400);
    const spacing0 = c0.barSpacing;
    chart.engine.wheel(0, -200, 400, 200);
    const c1 = chart.coords();
    expect(c1.barSpacing).toBeGreaterThan(spacing0);
    expect(c1.indexOfX(400)).toBe(anchorIndex);

    const axisX = c1.priceAxis.x + 10;
    chart.engine.pointerDown(axisX, 200);
    chart.engine.pointerMove(axisX, 260);
    chart.engine.pointerUp(axisX, 260);
    expect(chart.getViewport().priceMode).toBe('manual');
    chart.engine.doubleClick(axisX, 200);
    expect(chart.getViewport().priceMode).toBe('auto');

    chart.engine.doubleClick(300, 200);
    chart.render();
    expect(chart.coords().barSpacing).toBeCloseTo(spacing0, 6);
    chart.destroy();
  });

  it('continuous sessions leave gaps for missing bars', () => {
    const bars = continuousBars(50);
    bars.splice(20, 5);
    const chart = headless({
      sessions: { mode: 'continuous', timezone: 'UTC', dayStartMinutes: 0 },
      timeframeMs: 60_000,
    });
    chart.setData('main', bars);
    chart.render();
    const c = chart.coords();
    expect(c.xOfIndex(20) - c.xOfIndex(19)).toBeCloseTo(6 * c.barSpacing, 6);
    expect(c.xOfIndex(21) - c.xOfIndex(20)).toBeCloseTo(c.barSpacing, 6);
    chart.destroy();
  });

  it('auto-sizes the price axis to the widest label', () => {
    const small = headless();
    small.setData('main', equityBars(1, 1, 4.25));
    small.render();
    const big = headless();
    big.setData('main', equityBars(1, 1, 98_412));
    big.render();
    expect(big.coords().priceAxis.w).toBeGreaterThan(small.coords().priceAxis.w);
    expect(small.coords().priceAxis.w).toBeGreaterThanOrEqual(48);
    small.destroy();
    big.destroy();
  });

  it('layer registry: kinds, z-order, visibility, events', () => {
    const chart = headless();
    const bars = equityBars(2);
    chart.setData('main', bars);
    const events: LayerInfo[][] = [];
    chart.on('layers', (l) => events.push([...l]));
    chart.addLayer(vwapLayer(bars));
    const levels = new LevelsLayer({
      id: 'gex',
      provider: 'Zeta · Classic',
      levels: [{ id: 'mg', price: 490, label: 'Max +Gamma', short: 'MG', vendor: 'Zeta · Classic', include: true }],
    });
    chart.addLayer(levels);
    expect(() => chart.addLayer(levels)).toThrow(/already exists/);
    const list = chart.layers();
    expect(list.map((l) => l.id)).toEqual([
      'grid',
      'vwap',
      'candles',
      'volume',
      'gex',
      'last-price',
      'legend',
      'crosshair',
    ]);
    expect(list.find((l) => l.id === 'gex')).toMatchObject({
      kind: 'overlay',
      provider: 'Zeta · Classic',
      surface: 'overlay',
    });
    expect(list.find((l) => l.id === 'vwap')).toMatchObject({ kind: 'study', surface: 'main' });
    chart.setLayerVisible('gex', false);
    expect(chart.layers().find((l) => l.id === 'gex')?.visible).toBe(false);
    chart.setLayerZ('vwap', 50);
    expect(
      chart
        .layers()
        .map((l) => l.id)
        .indexOf('vwap'),
    ).toBeGreaterThan(
      chart
        .layers()
        .map((l) => l.id)
        .indexOf('candles'),
    );
    expect(chart.removeLayer('gex')).toBe(true);
    expect(chart.removeLayer('gex')).toBe(false);
    expect(events).toHaveLength(5);
    chart.destroy();
  });

  it('levels: included levels stretch the auto range; hit testing finds the nearest level', () => {
    const chart = headless();
    chart.setData('main', equityBars(2, 7, 487));
    chart.addLayer(
      new LevelsLayer({
        id: 'gex',
        provider: 'Zeta · Classic',
        levels: [
          { id: 'mg', price: 495, label: 'Max +Gamma', short: 'MG', vendor: 'Zeta · Classic', include: true },
          { id: 'pw', price: 300, label: 'Put Wall', short: 'PW', vendor: 'Zeta · Classic' },
        ],
      }),
    );
    chart.render();
    const vp = chart.getViewport();
    expect(vp.priceMax).toBeGreaterThan(495);
    expect(vp.priceMin).toBeGreaterThan(300);
    const c = chart.coords();
    const y = c.yOfPrice(495);
    expect(chart.engine.hitTest(200, y + 2)).toEqual([
      { layerId: 'gex', objectId: 'mg', distance: expect.closeTo(2, 5) as number },
    ]);
    expect(chart.engine.hitTest(200, y + 30)).toEqual([]);
    const clicks: unknown[] = [];
    chart.on('click', (e) => clicks.push(e.hits));
    chart.engine.pointerDown(200, y);
    chart.engine.pointerUp(200, y);
    expect(clicks).toEqual([[{ layerId: 'gex', objectId: 'mg', distance: expect.closeTo(0, 5) as number }]]);
    chart.engine.pointerDown(200, y);
    chart.engine.pointerCancel();
    expect(clicks, 'a cancelled press is no click').toHaveLength(1);
    expect(chart.engine.cursorAt(200, y)).toBe('pointer');
    chart.destroy();
  });

  it('levels and legend can keep the plot quiet: one vendor chip, no short codes, legend on hover only', () => {
    const texts: string[] = [];
    const chart = headless({
      legend: { title: '', hover: true },
      createCanvas: (w, h) => {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const fillText = ctx.fillText.bind(ctx);
        ctx.fillText = (text: string, x: number, y: number) => {
          texts.push(text);
          fillText(text, x, y);
        };
        return canvas;
      },
    });
    chart.setData('main', equityBars(2, 7, 487));
    chart.addLayer(
      new LevelsLayer({
        id: 'gex',
        vendorOnce: true,
        shortTags: false,
        levels: [
          { id: 'mg', price: 490, label: 'Max +Gamma', short: 'MG', vendor: 'Zeta · Classic', include: true },
          { id: 'gf', price: 486, label: 'Gamma Flip', short: 'GF', vendor: 'Zeta · Classic', include: true },
        ],
      }),
    );
    chart.render(true);
    expect(texts.filter((t) => t === 'Zeta · Classic')).toHaveLength(1);
    expect(texts).toContain('Gamma Flip');
    expect(texts).not.toContain('MG');
    expect(texts).not.toContain('O');
    texts.length = 0;
    chart.engine.pointerMove(600, 200);
    chart.render(true);
    expect(texts).toContain('O');
    chart.destroy();
  });

  it('tags a level beyond the view with its price grouped like the axis', () => {
    const texts: string[] = [];
    const chart = headless({
      priceFormat: { precision: 2, minMove: 0.25 },
      createCanvas: (w, h) => {
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const fillText = ctx.fillText.bind(ctx);
        ctx.fillText = (text: string, x: number, y: number) => {
          texts.push(text);
          fillText(text, x, y);
        };
        return canvas;
      },
    });
    chart.setData('main', equityBars(2, 7, 29_600));
    chart.addLayer(
      new LevelsLayer({
        id: 'prior-day',
        levels: [
          { id: 'pdh', price: 29_983.5, label: 'Prior day high', short: 'PDH' },
          { id: 'pdl', price: 29_226, label: 'Prior day low', short: 'PDL' },
        ],
      }),
    );
    chart.render(true);
    expect(texts.filter((t) => /^[▲▼]/.test(t))).toEqual(['▲ PDH 29,983.50', '▼ PDL 29,226.00']);
    chart.destroy();
  });

  it('labels the crosshair price on the tick, and reports the price under the pointer as it is', () => {
    const chart = headless({ priceFormat: { precision: 2, minMove: 0.25 } });
    chart.setData('main', equityBars(2, 7, 29_700));
    chart.render(true);
    const onAxis: string[] = [];
    const ctx = chart.canvases.overlay.getContext('2d') as { fillText(t: string, x: number, y: number): void };
    const fillText = ctx.fillText.bind(ctx);
    ctx.fillText = (text, x, y) => {
      if (x >= chart.coords().priceAxis.x) onAxis.push(text);
      fillText(text, x, y);
    };
    const reported: number[] = [];
    chart.on('crosshair', (e) => {
      if (e) reported.push(e.price);
    });
    const { priceMin, priceMax } = chart.getViewport();
    const tick = Math.round((priceMin + priceMax) / 2);
    const between = tick + 0.1;
    chart.engine.pointerMove(600, chart.coords().yOfPrice(between));
    chart.render(true);
    const grouped = (p: number) => p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(onAxis).toContain(grouped(tick));
    expect(onAxis).not.toContain(grouped(between));
    expect(reported.at(-1)).toBeCloseTo(between, 6);
    chart.destroy();
  });

  it('keeps the OHLC legend inside the plot of a narrow chart, dropping its least telling parts', () => {
    const legendTexts = (width: number) => {
      const drawn: { text: string; right: number }[] = [];
      let row: number | null = null;
      const chart = headless({
        width,
        legend: { title: '', hover: true },
        createCanvas: (w, h) => {
          const canvas = createCanvas(w, h);
          const ctx = canvas.getContext('2d');
          const fillText = ctx.fillText.bind(ctx);
          ctx.fillText = (text: string, x: number, y: number) => {
            if (y === row) drawn.push({ text, right: x + ctx.measureText(text).width });
            fillText(text, x, y);
          };
          return canvas;
        },
      });
      chart.setData('main', equityBars(2, 7, 20641));
      chart.render(true);
      const { plot, priceAxis } = chart.coords();
      row = plot.y + 16;
      chart.engine.pointerMove(plot.x + plot.w / 2, plot.y + plot.h / 2);
      chart.render(true);
      chart.destroy();
      return { drawn, axisX: priceAxis.x };
    };
    const wide = legendTexts(1200);
    expect(wide.drawn.map((d) => d.text)).toEqual(expect.arrayContaining(['O', 'H', 'L', 'C']));
    for (const width of [420, 300, 220, 160]) {
      const { drawn, axisX } = legendTexts(width);
      for (const d of drawn) expect(d.right, `${d.text} at width ${String(width)}`).toBeLessThanOrEqual(axisX);
      if (width >= 220) expect(drawn.map((d) => d.text)).toContain('C');
    }
    const narrow = legendTexts(300).drawn.map((d) => d.text);
    expect(narrow).not.toContain('O');
  });

  it('keeps the legend on at rest, with the app’s second row dropped from the end to fit', () => {
    const drawn: { text: string; y: number; right: number }[] = [];
    const legendAt = (width: number) => {
      drawn.length = 0;
      const chart = headless({
        width,
        legend: { title: '' },
        createCanvas: (w, h) => {
          const canvas = createCanvas(w, h);
          const ctx = canvas.getContext('2d');
          const fillText = ctx.fillText.bind(ctx);
          ctx.fillText = (text: string, x: number, y: number) => {
            drawn.push({ text, y, right: x + ctx.measureText(text).width });
            fillText(text, x, y);
          };
          return canvas;
        },
      });
      chart.setData('main', equityBars(2, 7, 20641));
      const legend = chart.getLayer('legend', LegendLayer)!;
      legend.extra = () => [
        { text: 'VWAP', weight: 500, keepWithNext: true },
        { text: '20,618.40', color: '#6CD8C4', gap: 18 },
        { text: 'Zeta', weight: 500, keepWithNext: true },
        { text: 'Call Wall 20,850' },
        { text: '· Max +Gamma 20,900' },
      ];
      chart.render(true);
      const { plot, priceAxis } = chart.coords();
      chart.destroy();
      return { plot, axisX: priceAxis.x };
    };
    const { plot } = legendAt(1200);
    const first = drawn.filter((d) => d.y === plot.y + 16).map((d) => d.text);
    expect(first).toEqual(expect.arrayContaining(['O', 'H', 'L', 'C', 'Vol']));
    expect(drawn.filter((d) => d.y === plot.y + 35).map((d) => d.text)).toEqual([
      'VWAP',
      '20,618.40',
      'Zeta',
      'Call Wall 20,850',
      '· Max +Gamma 20,900',
    ]);
    const narrow = legendAt(260);
    const second = drawn.filter((d) => d.y === narrow.plot.y + 35);
    expect(second.map((d) => d.text)).toEqual(['VWAP', '20,618.40']);
    const legendRows = drawn.filter((d) => d.y === narrow.plot.y + 16 || d.y === narrow.plot.y + 35);
    for (const d of legendRows) expect(d.right).toBeLessThanOrEqual(narrow.axisX);
  });

  it('keeps every bar below the legend when the app’s study rows make it taller', () => {
    for (const [studyRows, words] of [
      [0, { title: '' }],
      [1, { title: '' }],
      [1, { title: 'NQ Z6 1m', subtitle: 'Apex · Rithmic' }],
      [3, { title: '' }],
    ] as const) {
      const chart = headless({ legend: words });
      const bars = equityBars(2, 7, 20641);
      chart.setData('main', bars);
      const legend = chart.getLayer('legend', LegendLayer)!;
      legend.extra = () => [{ text: 'Zeta', weight: 500 }];
      legend.reserved = studyRows * 22;
      chart.render(true);
      const c = chart.coords();
      const legendBottom = legend.extent!.y + legend.extent!.h;
      for (let i = c.from; i <= c.to; i++) expect(c.yOfPrice(bars[i]!.h)).toBeGreaterThan(legendBottom - 0.01);
      chart.destroy();
    }
  });

  it('keeps the OHLC row readable over a line drawn through it', () => {
    const chart = headless({ legend: { title: '' } });
    chart.setData('main', equityBars(3));
    const layer = new AnnotationLayer();
    chart.addLayer(layer);
    chart.render(true);
    const c = chart.coords();
    const rowY = c.plot.y + 16;
    layer.setAnnotations([{ id: 'h', kind: 'hline', points: [{ t: null, price: c.priceOfY(rowY) }], agent: true }]);
    chart.render(true);
    const legend = chart.getLayer('legend', LegendLayer)!.extent!;
    const agent = hex(chart.theme.agent);
    const isLine = (x: number, y: number) => {
      const [r, g, b, a] = pixel(chart, 'overlay', x, y);
      return a > 200 && Math.abs(r - agent[0]!) < 24 && Math.abs(g - agent[1]!) < 24 && Math.abs(b - agent[2]!) < 24;
    };
    const lineY = [-2, -1, 0, 1, 2]
      .map((d) => Math.round(rowY) + d)
      .find((y) => Array.from({ length: 60 }, (_, k) => c.plot.w - 120 + k).some((x) => isLine(x, y)))!;
    expect(lineY).toBeDefined();
    const inRow = Array.from({ length: Math.floor(legend.w) - 4 }, (_, k) => legend.x + 2 + k).filter((x) =>
      isLine(x, lineY),
    );
    expect(inRow).toEqual([]);
    chart.destroy();
  });

  it('draws annotations: agent lines dashed in the agent colour, anchored by time and price', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    const layer = new AnnotationLayer();
    chart.addLayer(layer);
    chart.render(true);
    const painted = () => {
      const ctx = chart.canvases.overlay.getContext('2d') as Ctx;
      const { data } = ctx.getImageData(0, 0, chart.canvases.overlay.width, chart.canvases.overlay.height);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
      return n;
    };
    const before = painted();
    const c = chart.coords();
    const last = bars.length - 1;
    const price = (bars[last]!.h + bars[last]!.l) / 2;
    layer.setAnnotations([
      { id: 'h', kind: 'hline', points: [{ t: null, price }], label: 'touch', agent: true },
      {
        id: 'b',
        kind: 'box',
        points: [
          { t: bars[last - 20]!.t, price: bars[last]!.h },
          { t: bars[last - 5]!.t, price: bars[last]!.l },
        ],
        agent: false,
      },
    ]);
    chart.render(true);
    expect(painted()).toBeGreaterThan(before + 500);
    const y = c.yOfPrice(price);
    const xs = Array.from({ length: 40 }, (_, k) => c.plot.x + 200 + k);
    const agent = hex(chart.theme.agent);
    const hits = xs.filter((x) => {
      const [r, g, b, a] = pixel(chart, 'overlay', x, y);
      return a > 0 && Math.abs(r - agent[0]!) < 40 && Math.abs(g - agent[1]!) < 40 && Math.abs(b - agent[2]!) < 40;
    });
    expect(hits.length).toBeGreaterThan(10);
    expect(hits.length).toBeLessThan(40);
    const rc = { price: { yOf: c.yOfPrice }, store: chart.getSeries(), time: { xOfIndex: c.xOfIndex } };
    expect(layer.hitTest(c.plot.x + 300, y, rc as never)?.objectId).toBe('h');
    layer.setAnnotations([]);
    chart.render(true);
    expect(painted()).toBeLessThanOrEqual(before + 50);
    chart.destroy();
  });

  it('crosshair moves redraw only the overlay surface and report the bar', () => {
    const chart = headless();
    const bars = equityBars(2);
    chart.setData('main', bars);
    chart.render();
    const frames: FrameEvent[] = [];
    const cross = vi.fn();
    chart.on('frame', (f) => frames.push(f));
    chart.on('crosshair', cross);
    const c = chart.coords();
    chart.engine.pointerMove(c.xOfIndex(100) + 1, 200);
    chart.render();
    expect(frames.at(-1)?.surfaces).toEqual(['overlay']);
    expect(cross.mock.calls[0]?.[0]).toMatchObject({ index: 100, bar: { t: bars[100]!.t } });
    chart.engine.pointerLeave();
    expect(cross.mock.calls.at(-1)?.[0]).toBeNull();
    chart.destroy();
  });

  it('last-price countdown is live only while the bar forms', () => {
    const bars = equityBars(1);
    const last = bars.at(-1)!;
    let now = last.t + 150_000;
    const chart = headless({ now: () => now });
    chart.setData('main', bars);
    const layer = chart.getLayer('last-price', LastPriceLayer)!;
    const rc = { store: chart.getSeries()!, timeframeMs: 300_000, now };
    expect(layer.isLive(rc)).toBe(true);
    now = last.t + 900_000;
    expect(layer.isLive({ ...rc, now })).toBe(false);
    chart.render();
    chart.destroy();
  });

  it('a stale last price keeps its price on the axis but stops counting the bar down', () => {
    const bars = equityBars(1);
    const last = bars.at(-1)!;
    const chart = headless({ now: () => last.t + 150_000 });
    chart.setData('main', bars);
    const axisText = () => {
      const ctx = chart.canvases.overlay.getContext('2d') as { fillText(text: string, x: number, y: number): void };
      const spy = vi.spyOn(ctx, 'fillText');
      chart.render(true);
      const words = spy.mock.calls.map((c) => c[0]);
      spy.mockRestore();
      return words;
    };
    const price = new PriceFormatter({ precision: 2, minMove: 0.01 }).grouped(last.c);
    expect(axisText()).toEqual(expect.arrayContaining([price, '02:30']));
    chart.setOptions({ lastPrice: 'stale' });
    const stale = axisText();
    expect(stale).toContain(price);
    expect(stale).not.toContain('02:30');
    expect(
      chart
        .getLayer('last-price', LastPriceLayer)!
        .isLive({ store: chart.getSeries()!, timeframeMs: 300_000, now: last.t + 150_000 }),
    ).toBe(false);
    chart.setOptions({ lastPrice: 'live' });
    expect(axisText()).toContain('02:30');
    chart.destroy();
  });

  it('a chart with the countdown off keeps its last price on the axis without the bar countdown', () => {
    const bars = equityBars(1);
    const last = bars.at(-1)!;
    const chart = headless({ now: () => last.t + 150_000 });
    chart.setData('main', bars);
    const axisText = () => {
      const ctx = chart.canvases.overlay.getContext('2d') as { fillText(text: string, x: number, y: number): void };
      const spy = vi.spyOn(ctx, 'fillText');
      chart.render(true);
      const words = spy.mock.calls.map((c) => c[0]);
      spy.mockRestore();
      return words;
    };
    const price = new PriceFormatter({ precision: 2, minMove: 0.01 }).grouped(last.c);
    chart.setOptions({ countdown: false });
    const quiet = axisText();
    expect(quiet).toContain(price);
    expect(quiet).not.toContain('02:30');
    chart.setOptions({ countdown: true });
    expect(axisText()).toContain('02:30');
    chart.destroy();
  });

  it('finds a layer by id only when it is of the class asked for', () => {
    const chart = headless();
    expect(chart.getLayer('legend', LegendLayer)).toBeInstanceOf(LegendLayer);
    expect(chart.getLayer('legend', LastPriceLayer)).toBeNull();
    expect(chart.getLayer('legend')).toBeInstanceOf(LegendLayer);
    expect(chart.getLayer('nothing', LegendLayer)).toBeNull();
    chart.destroy();
  });

  it('resize and DPR changes keep the right edge and rescale the canvases', () => {
    const chart = headless();
    chart.setData('main', equityBars(2));
    chart.render();
    const right = chart.getViewport().rightEdgeSlot;
    chart.engine.resize(800, 500, 2);
    chart.render();
    expect(chart.canvases.main.width).toBe(1600);
    expect(chart.canvases.overlay.height).toBe(1000);
    expect(chart.getViewport().rightEdgeSlot).toBe(right);
    chart.destroy();
  });

  it('repaints in the same task as a resize so the cleared canvases are never shown blank', () => {
    const chart = headless();
    chart.setData('main', equityBars(3));
    chart.render();
    const painted = (w: number, h: number) => {
      const ctx = chart.canvases.main.getContext('2d') as Ctx;
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
      return false;
    };
    for (const [w, h] of [
      [1100, 650],
      [1000, 650],
      [900, 640],
    ] as const) {
      chart.engine.resize(w, h, 1);
      expect(painted(w, h)).toBe(true);
    }
    chart.destroy();
  });

  it('a chart given its bars while hidden lays out its first view once it has a width', () => {
    const shown = headless();
    shown.setData('main', equityBars(2));
    shown.render();
    const hidden = headless({ width: 0, height: 0 });
    hidden.setData('main', equityBars(2));
    hidden.render();
    hidden.engine.resize(1200, 700, 1);
    hidden.render();
    expect(hidden.coords().barSpacing).toBeCloseTo(shown.coords().barSpacing, 9);
    expect(hidden.getViewport().rightEdgeSlot).toBe(shown.getViewport().rightEdgeSlot);
    shown.destroy();
    hidden.destroy();
  });

  it('setData with keepView keeps zoom and the time under the right edge', () => {
    const chart = headless();
    const bars = equityBars(3);
    chart.setData('main', bars);
    chart.render();
    chart.engine.wheel(0, -300, 600, 200);
    chart.engine.pointerDown(300, 200);
    chart.engine.pointerMove(500, 200);
    chart.engine.pointerUp(500, 200);
    const before = chart.getViewport();
    chart.setData('main', bars.slice(40), { keepView: true });
    const after = chart.getViewport();
    expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
    expect(after.toTime).toBe(before.toTime);
    expect(after.following).toBe(false);
    chart.setData('main', bars);
    expect(chart.getViewport().following).toBe(true);
    chart.destroy();
  });

  it('prepend adds older bars without moving the view, scrolled back or following', () => {
    const bars = equityBars(6);
    const older = bars.slice(0, 200);
    const newer = bars.slice(200);
    const chart = headless();
    chart.setData('main', newer);
    chart.render();
    chart.engine.wheel(0, -300, 600, 200);
    chart.engine.pointerDown(300, 200);
    chart.engine.pointerMove(500, 200);
    chart.engine.pointerUp(500, 200);
    const before = chart.getViewport();
    const xBefore = chart.coords().xOfTime(before.toTime!);
    const views: number[] = [];
    const off = chart.on('viewport', (v) => views.push(v.from));
    expect(chart.prepend('main', older)).toBe(200);
    off();
    const after = chart.getViewport();
    expect(chart.getSeries()!.length).toBe(bars.length);
    expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
    expect(after.toTime).toBe(before.toTime);
    expect(after.fromTime).toBe(before.fromTime);
    expect(after.from).toBe(before.from + 200);
    expect(after.following).toBe(false);
    expect(chart.coords().xOfTime(after.toTime!)).toBeCloseTo(xBefore!, 6);
    expect(views).toEqual([after.from]);
    expect(chart.prepend('main', bars.slice(300, 310))).toBe(0);
    chart.destroy();

    const live = headless();
    live.setData('main', newer);
    live.render();
    const edge = live.getViewport();
    live.prepend('main', older);
    const now = live.getViewport();
    expect(now.following).toBe(true);
    expect(now.toTime).toBe(edge.toTime);
    expect(now.to - now.from).toBe(edge.to - edge.from);
    expect(now.barSpacing).toBeCloseTo(edge.barSpacing, 9);
    live.setViewport({ range: { from: older[0]!.t, to: older[150]!.t } });
    expect(live.getViewport().from).toBe(0);
    live.destroy();
  });

  describe('an asked view', () => {
    const shownBars = (chart: ReturnType<typeof headless>) => {
      const s = chart.getViewport().shown!;
      return s.to - s.from + 1;
    };

    it('shows exactly the last bars asked for, and keeps them while hidden, re-shown and refilled', () => {
      const bars = continuousBars(2000);
      const chart = headless();
      chart.setData('main', bars);
      chart.setViewport({ lastBars: 700 });
      chart.render(true);
      expect(shownBars(chart)).toBe(700);
      chart.engine.resize(1, 1, 1);
      chart.setData('main', bars, { keepView: true });
      chart.render(true);
      chart.engine.resize(900, 600, 1);
      chart.render(true);
      expect(shownBars(chart)).toBe(700);
      expect(chart.getViewport().following).toBe(true);
      chart.destroy();
    });

    it('fits the bars asked for right of the band the app keeps clear, every bar it holds included', () => {
      const chart = headless();
      chart.setData('main', continuousBars(2000));
      chart.setOptions({ clearLeft: 120 });
      chart.setViewport({ lastBars: 300 });
      chart.render(true);
      expect(shownBars(chart)).toBe(300);
      chart.setViewport({ fitAll: true });
      chart.render(true);
      expect(shownBars(chart)).toBe(2000);
      chart.destroy();
    });

    it('waits for bars and a width when asked before either, then shows what it holds', () => {
      const bars = continuousBars(2000);
      const chart = headless({ width: 0, height: 0 });
      chart.setViewport({ lastBars: 900 });
      chart.setData('main', bars.slice(-351));
      chart.engine.resize(1200, 700, 1);
      chart.render(true);
      expect(shownBars(chart)).toBe(351);
      expect(chart.getViewport().asked).toEqual({ lastBars: 900 });
      chart.prepend('main', bars.slice(0, -351));
      chart.render(true);
      expect(shownBars(chart)).toBe(900);
      chart.destroy();
    });

    it('fits every bar it holds, older pages included, and does not fall back to the first view', () => {
      const bars = continuousBars(1500);
      const chart = headless({ width: 0, height: 0 });
      chart.setData('main', bars.slice(500));
      chart.setViewport({ fitAll: true });
      chart.engine.resize(1200, 700, 1);
      chart.render(true);
      expect(shownBars(chart)).toBe(1000);
      chart.prepend('main', bars.slice(0, 500));
      chart.render(true);
      expect(shownBars(chart)).toBe(1500);
      chart.destroy();
    });

    it('shows the range asked for once its bars arrive', () => {
      const bars = continuousBars(600);
      const chart = headless();
      chart.setData('main', bars.slice(300));
      chart.setViewport({ range: { from: bars[100]!.t, to: bars[199]!.t } });
      chart.render(true);
      expect(chart.getViewport().fromTime).toBe(bars[300]!.t);
      chart.prepend('main', bars.slice(0, 300));
      chart.render(true);
      const v = chart.getViewport();
      expect([bars[v.shown!.from]!.t, bars[v.shown!.to]!.t]).toEqual([bars[100]!.t, bars[199]!.t]);
      chart.destroy();
    });

    it('starts a range at the bar that spans its start, as a daily bar opens the evening before its day', () => {
      const day = 86_400_000;
      const evening = Date.UTC(2026, 9, 1, 22);
      const bars = continuousBars(30, evening, 5).map((b, i) => ({ ...b, t: evening + i * day }));
      const chart = headless();
      chart.setOptions({ timeframeMs: day });
      chart.setData('main', bars);
      chart.setViewport({ range: { from: Date.UTC(2026, 9, 6), to: Date.UTC(2026, 9, 28) } });
      chart.render(true);
      const v = chart.getViewport();
      expect(bars[v.shown!.from]!.t).toBe(Date.UTC(2026, 9, 5, 22));
      expect(bars[v.shown!.to]!.t).toBe(Date.UTC(2026, 9, 27, 22));
      chart.destroy();
    });

    it('lets go once the user moves the time axis, and when a new series replaces the bars', () => {
      const bars = continuousBars(2000);
      const chart = headless();
      chart.setData('main', bars);
      chart.setViewport({ lastBars: 400 });
      chart.render(true);
      chart.engine.wheel(0, -300, 600, 200);
      expect(chart.getViewport().asked).toBeNull();
      chart.setViewport({ lastBars: 400 });
      chart.engine.keyDown('ArrowLeft');
      expect(chart.getViewport().asked).toBeNull();
      chart.setViewport({ fitAll: true, price: 'auto' });
      chart.setData('main', bars.slice(0, 50));
      expect(chart.getViewport().asked).toBeNull();
      chart.destroy();
    });
  });

  it('setOptions keeps the view when sessions are equal by value, and anchors it when they change', () => {
    const chart = headless();
    const bars = equityBars(3);
    const sessions = { mode: 'collapse' as const, timezone: 'America/New_York', dayStartMinutes: 0 };
    chart.setOptions({ sessions, timeframeMs: 300_000 });
    chart.setData('main', bars);
    chart.render();
    chart.engine.wheel(0, -300, 600, 200);
    chart.engine.pointerDown(300, 200);
    chart.engine.pointerMove(500, 200);
    chart.engine.pointerUp(500, 200);
    const before = chart.getViewport();
    expect(before.following).toBe(false);
    chart.setOptions({ sessions: { ...sessions }, timeframeMs: 300_000 });
    expect(chart.getViewport()).toEqual(before);
    chart.setOptions({ sessions: { ...sessions, mode: 'continuous', maxGapMs: 3 * 3_600_000 } });
    const after = chart.getViewport();
    expect(after.toTime).toBe(before.toTime);
    expect(after.barSpacing).toBeCloseTo(before.barSpacing, 9);
    expect(after.following).toBe(false);
    chart.destroy();
  });

  it('ignores secondary series for scales but stores them', () => {
    const chart = headless();
    chart.setData('main', equityBars(1));
    chart.setData('compare', equityBars(1, 9, 550));
    expect(chart.getSeries('compare')?.length).toBe(78);
    chart.update('compare', { t: equityBars(1)[77]!.t + 300_000, o: 1, h: 1, l: 1, c: 1, v: 1 });
    expect(chart.getSeries('compare')?.length).toBe(79);
    expect(chart.getSeries('main')?.length).toBe(78);
    chart.destroy();
  });
});
