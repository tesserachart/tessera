import { describe, expect, it, vi } from 'vitest';
import {
  AnnotationLayer,
  defaultLabel,
  distToSegment,
  drawingAxes,
  extendSegment,
  fibExtensionPrices,
  fibFanPrices,
  fibLevelPrices,
  formatAngle,
  formatDuration,
  formatLevel,
  hitShape,
  inPolygon,
  magnetPrice,
  measureStats,
  screenAngle,
  shapeOf,
  textCorners,
  type DrawingAxes,
  type DrawingEvent,
  type DrawingLabelSpec,
  type DrawingSpec,
  type LabelMetrics,
} from '../src/index.ts';
import { continuousBars, headless } from './fixtures.ts';
import { crispStroke } from '../src/render/draw.ts';
import type * as ShapeModule from '../src/drawings/shape.ts';

const shapesBuilt = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/drawings/shape.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ShapeModule>();
  return {
    ...actual,
    shapeOf: (...args: Parameters<typeof actual.shapeOf>) => {
      shapesBuilt.count++;
      return actual.shapeOf(...args);
    },
  };
});

const PANE = { x: 0, y: 0, w: 800, h: 400 };
const METRICS: LabelMetrics = { width: (t) => t.length * 7, lineHeight: () => 17 };
const COLORS = { agentColor: '#6cd8c4', upColor: '#5fc79c', downColor: '#ec7b78' };

function gridAxes(): DrawingAxes {
  const tf = 60_000;
  return {
    pane: PANE,
    tick: 0.25,
    barSpacing: 10,
    ready: true,
    key: 'grid',
    lastBarX: 400,
    xOfTime: (t) => (t / tf) * 10,
    timeOfX: (x) => Math.round(x / 10) * tf,
    indexOfTime: (t) => t / tf,
    yOfPrice: (p) => 400 - (p - 100) * 4,
    priceOfY: (y) => 100 + (400 - y) / 4,
    barAt: () => ({ o: 150, h: 160, l: 140, c: 155 }),
    formatPrice: (p) => p.toFixed(2),
  };
}

function spec(over: Partial<DrawingSpec> & Pick<DrawingSpec, 'kind' | 'points'>): DrawingSpec {
  return {
    id: 'd1',
    color: '#dcebef',
    width: 1,
    dash: 'solid',
    extend: 'none',
    locked: false,
    agent: false,
    ...over,
  };
}

describe('drawing geometry', () => {
  it('measures distances to segments and tells inside from outside', () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(inPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(inPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it('extends a line to the edge of the plot on the side asked, whichever anchor is there', () => {
    const a = { x: 100, y: 200 };
    const b = { x: 200, y: 100 };
    expect(extendSegment(a, b, 'none', PANE)).toEqual([a, b]);
    const right = extendSegment(a, b, 'right', PANE)!;
    expect(right[0]).toEqual(a);
    expect(right[1].y).toBeCloseTo(0);
    expect(right[1].x).toBeCloseTo(300);
    const both = extendSegment(a, b, 'both', PANE)!;
    expect(both[0].x).toBeCloseTo(0);
    expect(both[0].y).toBeCloseTo(300);
    const reversed = extendSegment(b, a, 'right', PANE)!;
    expect(Math.max(reversed[0].x, reversed[1].x)).toBeCloseTo(300);
    expect(Math.min(reversed[0].x, reversed[1].x)).toBeCloseTo(100);
    expect(extendSegment({ x: -10, y: -10 }, { x: -20, y: -5 }, 'both', PANE)).toBeNull();
  });

  it('puts a retracement level 0 at the second anchor and 1 at the first', () => {
    const levels = fibLevelPrices(100, 200, [0, 0.5, 0.618, 1, 1.618]);
    expect(levels.map((l) => l.price)).toEqual([200, 150, expect.closeTo(138.2, 9), 100, expect.closeTo(38.2, 9)]);
    expect(levels.map((l) => formatLevel(l.level))).toEqual(['0', '0.5', '0.618', '1', '1.618']);
  });

  it('reads a measure as price, ticks, percent, bars and time', () => {
    const t0 = Date.UTC(2026, 9, 2, 14);
    const s = measureStats({ price: 100, index: 10, t: t0 }, { price: 101.25, index: 15, t: t0 + 1_500_000 }, 0.25);
    expect(s).toEqual({ dPrice: 1.25, ticks: 5, pct: 1.25, bars: 5, ms: 1_500_000 });
    const down = measureStats({ price: 200, index: 4, t: 0 }, { price: 190, index: 1, t: -180_000 }, 0);
    expect(down.dPrice).toBe(-10);
    expect(down.pct).toBe(-5);
    expect(down.bars).toBe(-3);
    expect(Number.isNaN(down.ticks)).toBe(true);
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(1_500_000)).toBe('25m');
    expect(formatDuration(9_300_000)).toBe('2h 35m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(273_600_000)).toBe('3d 4h');
  });

  it('snaps the magnet to the open, high, low or close nearest the pointer', () => {
    const bar = { o: 150, h: 160, l: 140, c: 155 };
    const yOf = (p: number) => 400 - (p - 100) * 4;
    expect(magnetPrice(yOf(159), bar, yOf)).toBe(160);
    expect(magnetPrice(yOf(141), bar, yOf)).toBe(140);
    expect(magnetPrice(yOf(153), bar, yOf)).toBe(155);
    expect(magnetPrice(yOf(151), bar, yOf)).toBe(150);
  });
});

describe('drawing shapes and hit-testing', () => {
  const axes = gridAxes();
  it('hits a trend line along its stroke and its handles at its anchors, and nothing far off', () => {
    const d = spec({
      kind: 'trend_line',
      points: [
        { t: 10 * 60_000, price: 150 },
        { t: 30 * 60_000, price: 170 },
      ],
    });
    const s = shapeOf(d, axes, METRICS, COLORS)!;
    expect(s.lines[0]).toEqual({ a: { x: 100, y: 200 }, b: { x: 300, y: 120 } });
    expect(hitShape(s, 200, 162, true, METRICS)).toMatchObject({ id: 'd1', handle: null });
    expect(hitShape(s, 301, 121, true, METRICS)).toMatchObject({ handle: 1, distance: 0 });
    expect(hitShape(s, 200, 120, true, METRICS)).toBeNull();
    expect(hitShape(s, 400, 80, true, METRICS)).toBeNull();
    const ray = shapeOf({ ...d, kind: 'ray', extend: 'right' }, axes, METRICS, COLORS)!;
    expect(hitShape(ray, 400, 80, true, METRICS)).not.toBeNull();
  });

  it('grabs a rectangle by its body and its four corners', () => {
    const d = spec({
      kind: 'rectangle',
      points: [
        { t: 10 * 60_000, price: 150 },
        { t: 20 * 60_000, price: 140 },
      ],
    });
    const s = shapeOf(d, axes, METRICS, COLORS)!;
    expect(hitShape(s, 150, 220, true, METRICS)).toMatchObject({ handle: null });
    expect(s.handles.map((h) => [h.x, h.y, h.t, h.p])).toEqual([
      [100, 200, 0, 0],
      [200, 240, 1, 1],
      [100, 240, 0, 1],
      [200, 200, 1, 0],
    ]);
    expect(hitShape(s, 500, 220, true, METRICS)).toBeNull();
  });

  it('draws a horizontal line across the plot with its price on the axis', () => {
    const s = shapeOf(
      spec({ kind: 'horizontal_line', points: [{ t: Number.NaN, price: 125 }] }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(s.lines[0]).toEqual({ a: { x: 0, y: 300 }, b: { x: 800, y: 300 } });
    expect(s.tags).toEqual([{ price: 125, always: true }]);
    expect(hitShape(s, 650, 303, true, METRICS)).not.toBeNull();
  });

  it('keeps a channel parallel at the offset its third anchor sets', () => {
    const s = shapeOf(
      spec({
        kind: 'parallel_channel',
        points: [
          { t: 0, price: 150 },
          { t: 20 * 60_000, price: 160 },
          { t: 10 * 60_000, price: 145 },
        ],
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    const [base, par] = s.lines;
    expect(par!.a.y - base!.a.y).toBeCloseTo(40);
    expect(par!.b.y - base!.b.y).toBeCloseTo(40);
    expect(hitShape(s, 100, 200, true, METRICS)).not.toBeNull();
  });

  it('labels a measure with its readout and tints it by direction', () => {
    const d = spec({
      kind: 'measure',
      points: [
        { t: 10 * 60_000, price: 150 },
        { t: 35 * 60_000, price: 140 },
      ],
    });
    const s = shapeOf(d, axes, METRICS, COLORS)!;
    expect(s.labels[0]!.lines).toEqual(['−10.00 (−40)  −6.67%', '25 bars, 25m']);
    expect(s.fills[0]!.color).toBe(COLORS.downColor);
    const fib = shapeOf(
      spec({
        kind: 'fib_retracement',
        points: [
          { t: 0, price: 100 },
          { t: 10 * 60_000, price: 200 },
        ],
        levels: [0, 0.5, 1],
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(fib.texts.map((t) => t.lines[0])).toEqual(['0  200.00', '0.5  150.00', '1  100.00']);
  });

  it('draws an agent drawing in the agent colour whatever its own', () => {
    const s = shapeOf(
      spec({ kind: 'horizontal_line', points: [{ t: 0, price: 120 }], agent: true, color: '#ff0000' }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(s.color).toBe(COLORS.agentColor);
  });
});

function label(over: Partial<DrawingLabelSpec> = {}): DrawingLabelSpec {
  return {
    text: '',
    color: null,
    size: 12,
    bold: false,
    italic: false,
    align: 'center',
    position: 'above',
    showPrice: false,
    showLevels: true,
    ...over,
  };
}

const measure = (font: string, text: string) => text.length * Number(/(\d+)px/.exec(font)![1]) * 0.55;

describe('cross line, trend angle, fib extension and fib fan', () => {
  const axes = gridAxes();
  const at = (minutes: number, price: number) => ({ t: minutes * 60_000, price });

  it('projects an extension from the pullback by the move, and a fan level as a share of the rise', () => {
    expect(fibExtensionPrices(100, 110, 105, [0, 1, 1.618]).map((l) => l.price)).toEqual([105, 115, 121.18]);
    expect(fibExtensionPrices(110, 100, 105, [1]).map((l) => l.price)).toEqual([95]);
    expect(fibFanPrices(100, 200, [0.382, 0.5, 1]).map((l) => l.price)).toEqual([138.2, 150, 200]);
  });

  it('reads an angle from the horizontal as the chart shows it, up positive, whichever way it runs', () => {
    expect(screenAngle({ x: 0, y: 100 }, { x: 100, y: 0 })).toBeCloseTo(45);
    expect(screenAngle({ x: 0, y: 100 }, { x: -100, y: 0 })).toBeCloseTo(45);
    expect(screenAngle({ x: 0, y: 0 }, { x: 100, y: 100 })).toBeCloseTo(-45);
    expect(screenAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNaN();
    expect(formatAngle(26.565)).toBe('26.57°');
    expect(formatAngle(-32.4712)).toBe('−32.47°');
    expect(formatAngle(-0.001)).toBe('0.00°');
  });

  it('crosses a price and a bar time edge to edge, with its price on the axis and one handle', () => {
    const s = shapeOf(spec({ kind: 'cross_line', points: [at(20, 125)] }), axes, METRICS, COLORS)!;
    expect(s.lines).toEqual([
      { a: { x: 0, y: 300 }, b: { x: 800, y: 300 } },
      { a: { x: 200, y: 0 }, b: { x: 200, y: 400 } },
    ]);
    expect(s.tags).toEqual([{ price: 125, always: true }]);
    expect(s.handles.map((h) => [h.x, h.y])).toEqual([[200, 300]]);
    expect(hitShape(s, 202, 40, true, METRICS)).toMatchObject({ handle: null });
    expect(hitShape(s, 600, 302, true, METRICS)).toMatchObject({ handle: null });
    expect(hitShape(s, 600, 40, true, METRICS)).toBeNull();
  });

  it('shows a trend angle in degrees beside a level arm and an arc, on the side the line runs', () => {
    const up = shapeOf(spec({ kind: 'trend_angle', points: [at(10, 150), at(30, 175)] }), axes, METRICS, COLORS)!;
    expect(up.lines[0]).toEqual({ a: { x: 100, y: 200 }, b: { x: 300, y: 100 } });
    expect(up.lines[1]).toMatchObject({ a: { x: 100, y: 200 }, b: { x: 300, y: 200 }, dash: [3, 3] });
    expect(up.labels).toHaveLength(1);
    expect(up.labels[0]).toMatchObject({ lines: ['26.57°'], anchor: 'top', plate: 'none' });
    expect(up.labels[0]!.x).toBeGreaterThan(100);
    expect(up.handles).toHaveLength(2);
    const down = shapeOf(spec({ kind: 'trend_angle', points: [at(30, 175), at(10, 150)] }), axes, METRICS, COLORS)!;
    expect(down.labels[0]).toMatchObject({ lines: ['−26.57°'], anchor: 'bottom' });
    expect(down.labels[0]!.x).toBeLessThan(300);
    const arc = down.lines.filter((l) => l.dash?.length === 0);
    expect(arc.length).toBeGreaterThan(8);
    for (const l of arc) expect(Math.hypot(l.a.x - 300, l.a.y - 100)).toBeCloseTo(40);
  });

  it('draws extension levels from the pullback on, as wide as the move, labelled with level and price', () => {
    const d = spec({
      kind: 'fib_extension',
      points: [at(0, 100), at(10, 120), at(20, 110)],
      levels: [0, 1, 1.5],
    });
    const s = shapeOf(d, axes, METRICS, COLORS)!;
    const levels = s.lines.filter((l) => l.a.y === l.b.y && l.dash === undefined);
    expect(levels.map((l) => [l.a.x, l.b.x, l.a.y])).toEqual([
      [200, 300, 360],
      [200, 300, 280],
      [200, 300, 240],
    ]);
    expect(s.texts.map((t) => t.lines[0])).toEqual(['0  110.00', '1  130.00', '1.5  140.00']);
    expect(s.handles).toHaveLength(3);
    const extended = shapeOf({ ...d, extend: 'right' }, axes, METRICS, COLORS)!;
    expect(extended.lines.find((l) => l.a.y === 280)!.b.x).toBe(800);
    const placing = shapeOf({ ...d, points: d.points.slice(0, 2) }, axes, METRICS, COLORS)!;
    expect(placing.lines).toHaveLength(1);
    expect(placing.texts).toEqual([]);
  });

  it('fans rays from the first anchor through each level at the second anchor’s time', () => {
    const d = spec({ kind: 'fib_fan', points: [at(0, 100), at(10, 200)], levels: [0.5], extend: 'right' });
    const s = shapeOf(d, axes, METRICS, COLORS)!;
    const ray = s.lines[0]!;
    expect(ray.a).toEqual({ x: 0, y: 400 });
    expect(ray.b.x).toBeCloseTo(200);
    expect(ray.b.y).toBeCloseTo(0);
    expect(s.texts.map((t) => t.lines[0])).toEqual(['0.5']);
    expect(s.texts[0]).toMatchObject({ angle: 0, side: 'middle', align: 'start', y: 200 });
    expect(s.texts[0]!.x).toBeGreaterThan(100);
    expect(s.texts[0]!.plate).not.toBeNull();
    const atEdge = shapeOf({ ...d, levels: [0.382, 0.5], points: [at(0, 100), at(79.8, 200)] }, axes, METRICS, COLORS)!;
    expect(atEdge.texts.map((t) => t.align)).toEqual(['end', 'end']);
    expect(atEdge.texts[0]!.x).toBeLessThan(798);
    expect(hitShape(s, 150, 100, true, METRICS)).toMatchObject({ handle: null });
    const stopped = shapeOf({ ...d, extend: 'none' }, axes, METRICS, COLORS)!;
    expect(stopped.lines[0]!.b).toEqual({ x: 100, y: 200 });
    expect(hitShape(stopped, 150, 100, true, METRICS)).toBeNull();
    const hidden = shapeOf({ ...d, label: { ...defaultLabel('fib_fan'), showLevels: false } }, axes, METRICS, COLORS)!;
    expect(hidden.texts).toEqual([]);
  });
});

describe('labels on drawings', () => {
  const axes = gridAxes();
  const line = (over: Partial<DrawingSpec> = {}) =>
    spec({
      kind: 'trend_line',
      points: [
        { t: 10 * 60_000, price: 150 },
        { t: 30 * 60_000, price: 170 },
      ],
      ...over,
    });

  it('runs a sloped line’s words along it, at its start, middle or end, above, on or below it', () => {
    const mid = shapeOf(line({ label: label({ text: 'Swing high' }) }), axes, METRICS, COLORS)!;
    const t = mid.texts[0]!;
    expect(t.lines).toEqual(['Swing high']);
    expect(t.angle).toBeCloseTo(Math.atan2(-80, 200));
    expect([t.x, t.y]).toEqual([200, 160]);
    expect(t).toMatchObject({ align: 'center', side: 'above', plate: null, color: '#dcebef' });
    for (const c of textCorners(t, measure)) expect(c.y).toBeLessThan(200 - 0.4 * (c.x - 100) + 0.01);
    const start = shapeOf(
      line({ label: label({ text: 'a', align: 'left', position: 'below' }) }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(start.texts[0]!.x).toBeLessThan(110);
    expect(start.texts[0]!).toMatchObject({ align: 'start', side: 'below' });
    for (const c of textCorners(start.texts[0]!, measure)) expect(c.y).toBeGreaterThan(200 - 0.4 * (c.x - 100) - 0.01);
    const on = shapeOf(line({ label: label({ text: 'a', align: 'right', position: 'on' }) }), axes, METRICS, {
      ...COLORS,
      background: '#0b0e11',
    })!;
    expect(on.texts[0]!).toMatchObject({ align: 'end', side: 'middle', plate: { color: '#0b0e11', alpha: 1 } });
    expect(on.texts[0]!.x).toBeGreaterThan(290);
    const back = shapeOf(
      line({ points: [...line().points].reverse(), label: label({ text: 'a', align: 'left' }) }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(back.texts[0]!.angle).toBeCloseTo(Math.atan2(-80, 200));
    expect(back.texts[0]!.x).toBeLessThan(110);
  });

  it('moves with its drawing and is hit as part of it', () => {
    const d = line({ label: label({ text: 'Swing high', size: 16 }) });
    const s = shapeOf(d, axes, METRICS, COLORS)!;
    const moved = shapeOf(
      { ...d, points: d.points.map((p) => ({ t: p.t + 10 * 60_000, price: p.price + 5 })) },
      axes,
      METRICS,
      COLORS,
    )!;
    expect(moved.texts[0]!.x - s.texts[0]!.x).toBeCloseTo(100);
    expect(moved.texts[0]!.y - s.texts[0]!.y).toBeCloseTo(-20);
    const corners = textCorners(s.texts[0]!, measure);
    const cx = corners.reduce((a, c) => a + c.x, 0) / 4;
    const cy = corners.reduce((a, c) => a + c.y, 0) / 4;
    expect(hitShape(s, cx, cy, true, METRICS)).toMatchObject({ id: 'd1', handle: null });
    expect(hitShape(shapeOf(line(), axes, METRICS, COLORS)!, cx, cy, true, METRICS)).toBeNull();
    expect(s.box.y).toBeLessThanOrEqual(Math.min(...corners.map((c) => c.y)) + 0.01);
  });

  it('puts a level’s words at the right with its price, and a ray’s from its anchor', () => {
    const level = shapeOf(
      spec({
        kind: 'horizontal_line',
        points: [{ t: Number.NaN, price: 125 }],
        label: label({ text: 'Asia high', align: 'right', showPrice: true }),
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(level.texts[0]!).toMatchObject({ lines: ['Asia high  125.00'], x: 792, y: 300, angle: 0, align: 'end' });
    const priceOnly = shapeOf(
      spec({ kind: 'horizontal_line', points: [{ t: Number.NaN, price: 125 }], label: label({ showPrice: true }) }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(priceOnly.texts[0]!.lines).toEqual(['125.00']);
    const ray = shapeOf(
      spec({
        kind: 'horizontal_ray',
        points: [{ t: 20 * 60_000, price: 125 }],
        label: label({ text: 'PDH\nswept', align: 'left' }),
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(ray.texts[0]!).toMatchObject({ lines: ['PDH', 'swept'], x: 204, align: 'start' });
  });

  it('reads a vertical line’s words upwards, its left as above', () => {
    const s = shapeOf(
      spec({
        kind: 'vertical_line',
        points: [{ t: 20 * 60_000, price: Number.NaN }],
        label: label({ text: 'FOMC', align: 'right' }),
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    const t = s.texts[0]!;
    expect(t.angle).toBeCloseTo(-Math.PI / 2);
    expect([t.x, t.y]).toEqual([200, 8]);
    for (const c of textCorners(t, measure)) {
      expect(c.x).toBeLessThan(200);
      expect(c.y).toBeGreaterThanOrEqual(7.9);
    }
  });

  it('labels a box over its top, in its middle or under its bottom', () => {
    const box = (position: DrawingLabelSpec['position']) =>
      shapeOf(
        spec({
          kind: 'rectangle',
          points: [
            { t: 10 * 60_000, price: 150 },
            { t: 20 * 60_000, price: 140 },
          ],
          label: label({ text: 'Asia range', align: 'left', position }),
        }),
        axes,
        METRICS,
        COLORS,
      )!.texts[0]!;
    expect(box('above')).toMatchObject({ y: 200, side: 'above', x: 104, plate: null });
    expect(box('on')).toMatchObject({ y: 220, side: 'middle', plate: null });
    expect(box('below')).toMatchObject({ y: 240, side: 'below' });
  });

  it('shows or hides a retracement’s levels and prices, where its label puts them', () => {
    const fib = (over: Partial<DrawingLabelSpec>) =>
      shapeOf(
        spec({
          kind: 'fib_retracement',
          points: [
            { t: 0, price: 100 },
            { t: 10 * 60_000, price: 200 },
          ],
          levels: [0, 0.5, 1],
          label: label({ align: 'left', showPrice: true, ...over }),
        }),
        axes,
        METRICS,
        COLORS,
      )!;
    expect(fib({ showLevels: false }).texts.map((t) => t.lines[0])).toEqual(['200.00', '150.00', '100.00']);
    expect(fib({ showPrice: false }).texts.map((t) => t.lines[0])).toEqual(['0', '0.5', '1']);
    expect(fib({ showPrice: false, showLevels: false }).texts).toEqual([]);
    const right = fib({ align: 'right', position: 'below', color: '#e0b25a', bold: true }).texts[0]!;
    expect(right).toMatchObject({ align: 'end', side: 'below', color: '#e0b25a' });
    expect(right.font).toContain('700');
    expect(right.x).toBeCloseTo(98);
    expect(fib({}).labelAt).toBeNull();
  });

  it('labels an agent’s drawing in the agent colour, as its line, unless a colour was given', () => {
    const agent = shapeOf(line({ agent: true, label: label({ text: 'a' }) }), axes, METRICS, COLORS)!;
    expect(agent.texts[0]!.color).toBe(COLORS.agentColor);
    const given = shapeOf(line({ agent: true, label: label({ text: 'a', color: '#e0b25a' }) }), axes, METRICS, COLORS)!;
    expect(given.texts[0]!.color).toBe('#e0b25a');
    expect(given.texts[0]!.font).toBe('500 12px sans-serif');
    const italic = shapeOf(line({ label: label({ text: 'a', italic: true, size: 14 }) }), axes, METRICS, {
      ...COLORS,
      family: 'Inter',
    })!;
    expect(italic.texts[0]!.font).toBe('italic 500 14px Inter');
  });

  it('knows where words would go before there are any, and draws none until then', () => {
    const s = shapeOf(line(), axes, METRICS, COLORS)!;
    expect(s.texts).toEqual([]);
    expect(s.labelAt).not.toBeNull();
    expect(Math.abs(s.labelAt!.x - 200)).toBeLessThan(4);
    expect(s.labelAt!.y).toBeLessThan(160);
    const m = shapeOf(
      spec({
        kind: 'measure',
        points: [
          { t: 0, price: 100 },
          { t: 10 * 60_000, price: 200 },
        ],
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(m.labelAt).toBeNull();
  });
});

describe('drawing axes on a chart', () => {
  it('maps bar times to x and back, and on past the last bar at the interval', () => {
    const chart = headless({
      timeframeMs: 60_000,
      sessions: { mode: 'continuous', timezone: 'UTC', dayStartMinutes: 0 },
    });
    const bars = continuousBars(300);
    chart.setData('main', bars);
    chart.render();
    const c = chart.coords();
    const layer = new AnnotationLayer();
    chart.addLayer(layer);
    const rc = {
      store: chart.getSeries()!,
      session: (chart.engine as unknown as { session: never }).session,
      time: { from: c.from, to: c.to, barSpacing: c.barSpacing, xOfIndex: c.xOfIndex, indexOfX: c.indexOfX },
      timeframeMs: 60_000,
      price: { min: 0, max: 1, yOf: c.yOfPrice, priceOf: c.priceOfY },
      pane: c.plot,
      format: { minMove: 0.01, grouped: (p: number) => String(p) },
    } as unknown as Parameters<typeof drawingAxes>[0];
    const axes = drawingAxes(rc);
    const t = bars[250]!.t;
    expect(axes.xOfTime(t)).toBeCloseTo(c.xOfIndex(250));
    expect(axes.timeOfX(c.xOfIndex(250) + 2)).toBe(t);
    const last = bars.at(-1)!.t;
    const future = last + 3 * 60_000;
    expect(axes.xOfTime(future)).toBeCloseTo(c.xOfIndex(299) + 3 * c.barSpacing);
    expect(axes.timeOfX(axes.xOfTime(future))).toBe(future);
    expect(axes.indexOfTime(future)).toBe(302);
    expect(axes.xOfTime(t + 30_000)).toBeCloseTo(c.xOfIndex(250));
  });
});

describe('drawing tools on the chart (headless)', () => {
  function setup() {
    const chart = headless({
      timeframeMs: 60_000,
      sessions: { mode: 'continuous', timezone: 'UTC', dayStartMinutes: 0 },
    });
    const bars = continuousBars(300);
    chart.setData('main', bars);
    const layer = new AnnotationLayer();
    chart.addLayer(layer);
    const events: DrawingEvent[] = [];
    layer.onDrawing = (e) => events.push(e);
    chart.render();
    const c = chart.coords();
    return { chart, bars, layer, events, c, engine: chart.engine };
  }

  it('places a trend line by two clicks, anchored to bar times, with a live preview between', () => {
    const { layer, events, c, engine, bars } = setup();
    layer.setDrawingTool('trend_line');
    const x1 = c.xOfIndex(200);
    const x2 = c.xOfIndex(240);
    engine.pointerDown(x1, 300);
    engine.pointerUp(x1, 300);
    expect(events).toEqual([]);
    expect(layer.drawingBusy).toBe(true);
    engine.pointerMove(x2, 250);
    engine.pointerDown(x2, 250);
    engine.pointerUp(x2, 250);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('create');
    if (e.type !== 'create') return;
    expect(e.kind).toBe('trend_line');
    expect(e.points.map((p) => p.t)).toEqual([bars[200]!.t, bars[240]!.t]);
    expect(e.points[0]!.price).toBeCloseTo(c.priceOfY(300));
    expect(layer.drawingBusy).toBe(false);
  });

  it('places a fib extension by its move and then its pullback, previewing the move first', () => {
    const { layer, events, c, engine, bars } = setup();
    layer.setDrawingTool('fib_extension');
    engine.pointerDown(c.xOfIndex(150), 300);
    engine.pointerMove(c.xOfIndex(170), 200);
    engine.pointerUp(c.xOfIndex(170), 200);
    expect(events).toEqual([]);
    expect(layer.drawingBusy).toBe(true);
    engine.pointerMove(c.xOfIndex(180), 260);
    engine.pointerDown(c.xOfIndex(180), 260);
    engine.pointerUp(c.xOfIndex(180), 260);
    const e = events[0]!;
    expect(e.type).toBe('create');
    if (e.type !== 'create') return;
    expect(e.kind).toBe('fib_extension');
    expect(e.points.map((p) => p.t)).toEqual([bars[150]!.t, bars[170]!.t, bars[180]!.t]);
  });

  it('keeps a trend angle level with Shift, like a trend line', () => {
    const { layer, events, c, engine } = setup();
    layer.setDrawingTool('trend_angle');
    engine.pointerDown(c.xOfIndex(150), 300);
    engine.pointerMove(c.xOfIndex(180), 200, { shift: true });
    engine.pointerUp(c.xOfIndex(180), 200, { shift: true });
    const e = events[0]!;
    expect(e.type === 'create' && e.points[1]!.price).toBe(e.type === 'create' && e.points[0]!.price);
  });

  it('places by a drag from the first anchor to the second, and Shift keeps a line level', () => {
    const { layer, events, c, engine } = setup();
    layer.setDrawingTool('ray');
    engine.pointerDown(c.xOfIndex(150), 300);
    engine.pointerMove(c.xOfIndex(180), 200, { shift: true });
    engine.pointerUp(c.xOfIndex(180), 200, { shift: true });
    const e = events[0]!;
    expect(e.type).toBe('create');
    if (e.type === 'create') expect(e.points[1]!.price).toBe(e.points[0]!.price);
  });

  it('snaps to the bar with the magnet, and ⌘/Ctrl turns it off while held', () => {
    const { layer, events, c, engine, bars } = setup();
    layer.setMagnet(true);
    layer.setDrawingTool('horizontal_line');
    const b = bars[220]!;
    engine.pointerDown(c.xOfIndex(220), c.yOfPrice(b.h) + 1);
    const e = events[0]!;
    expect(e.type === 'create' && e.points[0]!.price).toBe(b.h);
    layer.setDrawingTool('horizontal_line');
    const y = c.yOfPrice(b.h) + 3;
    engine.pointerDown(c.xOfIndex(220), y, 0, { cmdOrCtrl: true });
    const f = events[1]!;
    expect(f.type === 'create' && f.points[0]!.price).toBeCloseTo(c.priceOfY(y));
  });

  it('selects a drawing by click and drags it by whole bars without panning the chart', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    const line: DrawingSpec = spec({
      kind: 'trend_line',
      points: [
        { t: bars[200]!.t, price: c.priceOfY(300) },
        { t: bars[240]!.t, price: c.priceOfY(200) },
      ],
    });
    layer.setDrawings([line]);
    chart.render();
    const before = chart.getViewport();
    const mid = { x: (c.xOfIndex(200) + c.xOfIndex(240)) / 2, y: 250 };
    expect(engine.cursorAt(mid.x, mid.y)).toBe('grab');
    engine.pointerDown(mid.x, mid.y);
    expect(events).toEqual([{ type: 'select', id: 'd1' }]);
    engine.pointerMove(mid.x + 5 * c.barSpacing, mid.y + 40);
    engine.pointerUp(mid.x + 5 * c.barSpacing, mid.y + 40);
    expect(chart.getViewport().rightEdgeSlot).toBe(before.rightEdgeSlot);
    const moved = events[1]!;
    expect(moved.type).toBe('move');
    if (moved.type !== 'move') return;
    expect(moved.points.map((p) => p.t)).toEqual([bars[205]!.t, bars[245]!.t]);
    expect(moved.points[0]!.price).toBeCloseTo(c.priceOfY(340));
    expect(layer.getDrawings()[0]!.points[0]!.t).toBe(bars[205]!.t);
  });

  it('drags one anchor by its handle and leaves the other where it was', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    layer.setDrawings([
      spec({
        kind: 'trend_line',
        points: [
          { t: bars[200]!.t, price: c.priceOfY(300) },
          { t: bars[240]!.t, price: c.priceOfY(200) },
        ],
      }),
    ]);
    chart.render();
    engine.pointerDown(c.xOfIndex(240), 200);
    engine.pointerMove(c.xOfIndex(260), 150);
    engine.pointerUp(c.xOfIndex(260), 150);
    const e = events.find((x) => x.type === 'move');
    expect(e?.type === 'move' && e.points[1]!.t).toBe(bars[260]!.t);
    expect(e?.type === 'move' && e.points[0]!.t).toBe(bars[200]!.t);
  });

  it('leaves a drawing where it was when the pointer is cancelled mid-drag, and pans nothing after', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    layer.setDrawings([
      spec({
        kind: 'trend_line',
        points: [
          { t: bars[200]!.t, price: c.priceOfY(300) },
          { t: bars[240]!.t, price: c.priceOfY(200) },
        ],
      }),
    ]);
    chart.render();
    const before = chart.getViewport();
    engine.pointerDown(c.xOfIndex(240), 200);
    engine.pointerMove(c.xOfIndex(260), 150);
    expect(engine.pointerCancel()).toBe(true);
    engine.pointerMove(c.xOfIndex(100), 100);
    expect(events.filter((e) => e.type === 'move')).toEqual([]);
    expect(layer.getDrawings()[0]!.points[1]!.t).toBe(bars[240]!.t);
    expect(chart.getViewport().rightEdgeSlot).toBe(before.rightEdgeSlot);
    expect(engine.pointerCancel()).toBe(false);
  });

  it('removes the selected drawing with Delete, cancels with Escape, and a locked drawing does not move', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    const locked = spec({
      kind: 'horizontal_line',
      points: [{ t: bars[100]!.t, price: c.priceOfY(250) }],
      locked: true,
    });
    layer.setDrawings([locked]);
    chart.render();
    engine.pointerDown(400, 250);
    engine.pointerMove(400, 290);
    engine.pointerUp(400, 290);
    expect(events.map((e) => e.type)).toEqual(['select']);
    expect(engine.keyDown('Delete')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'remove', id: 'd1' });
    layer.setDrawingTool('rectangle');
    engine.pointerDown(300, 300);
    engine.pointerUp(300, 300);
    expect(layer.drawingBusy).toBe(true);
    expect(engine.keyDown('Escape')).toBe(true);
    expect(layer.drawingBusy).toBe(false);
    expect(engine.keyDown('Escape')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'cancel' });
  });

  it('clicking empty plot clears the selection and pans as before', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    layer.setDrawings([spec({ kind: 'horizontal_line', points: [{ t: bars[100]!.t, price: c.priceOfY(250) }] })]);
    layer.selectDrawing('d1');
    chart.render();
    const before = chart.getViewport().rightEdgeSlot;
    engine.pointerDown(400, 100);
    engine.pointerMove(300, 100);
    engine.pointerUp(300, 100);
    expect(events).toEqual([{ type: 'select', id: null }]);
    expect(chart.getViewport().rightEdgeSlot).not.toBe(before);
  });

  it('a note opens its text on double-click, and a double-click on a drawing keeps the view', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    layer.setDrawings([
      spec({ kind: 'text', text: 'Opening drive', points: [{ t: bars[230]!.t, price: c.priceOfY(200) }] }),
    ]);
    chart.render();
    engine.pointerDown(400, 100);
    engine.pointerMove(300, 100);
    engine.pointerUp(300, 100);
    chart.render();
    const vp = chart.getViewport();
    const c2 = chart.coords();
    engine.doubleClick(c2.xOfIndex(230) + 10, c2.yOfPrice(c.priceOfY(200)) + 8);
    expect(events).toContainEqual({ type: 'edit-text', id: 'd1' });
    expect(chart.getViewport()).toEqual(vp);
  });

  it('a line opens its label’s words on double-click and is selected; a retracement has none to open', () => {
    const { chart, layer, events, c, engine, bars } = setup();
    const price = c.priceOfY(200);
    layer.setDrawings([
      spec({ id: 'lvl', kind: 'horizontal_line', points: [{ t: Number.NaN, price }] }),
      spec({
        id: 'fib',
        kind: 'fib_retracement',
        points: [
          { t: bars[100]!.t, price: c.priceOfY(320) },
          { t: bars[140]!.t, price: c.priceOfY(280) },
        ],
      }),
    ]);
    chart.render();
    engine.doubleClick(c.xOfIndex(250), c.yOfPrice(price));
    expect(events).toContainEqual({ type: 'select', id: 'lvl' });
    expect(events).toContainEqual({ type: 'edit-text', id: 'lvl' });
    expect(layer.drawingLabelAt('lvl')).not.toBeNull();
    events.length = 0;
    engine.doubleClick(c.xOfIndex(120), c.yOfPrice(c.priceOfY(300)));
    expect(events.some((e) => e.type === 'edit-text')).toBe(false);
  });

  it('builds each drawing shape once per view, however long the pointer roams over hundreds of drawings', () => {
    const { chart, layer, engine, bars, c } = setup();
    const many: DrawingSpec[] = [];
    for (let i = 0; i < 300; i++) {
      const k = 150 + (i % 140);
      many.push(
        spec({
          id: `d${String(i)}`,
          kind: i % 3 === 0 ? 'trend_line' : i % 3 === 1 ? 'rectangle' : 'fib_retracement',
          points: [
            { t: bars[k]!.t, price: c.priceOfY(100 + (i % 50) * 6) },
            { t: bars[k + 8]!.t, price: c.priceOfY(150 + (i % 40) * 7) },
          ],
        }),
      );
    }
    const roam = () => {
      for (let k = 0; k < 200; k++) {
        const x = 200 + (k % 400);
        const y = 100 + ((k * 7) % 400);
        engine.pointerMove(x, y);
        engine.cursorAt(x, y);
      }
    };
    layer.setDrawings(many);
    shapesBuilt.count = 0;
    chart.render();
    expect(shapesBuilt.count).toBe(many.length);
    shapesBuilt.count = 0;
    roam();
    expect(shapesBuilt.count).toBe(0);
    chart.setViewport({ barSpacing: 14 });
    shapesBuilt.count = 0;
    chart.render();
    expect(shapesBuilt.count).toBe(many.length);
    shapesBuilt.count = 0;
    roam();
    chart.render();
    expect(shapesBuilt.count).toBe(0);
  });

  it('drops a selection whose drawing went away', () => {
    const { layer, events, bars, c } = setup();
    layer.setDrawings([spec({ kind: 'horizontal_line', points: [{ t: bars[1]!.t, price: c.priceOfY(250) }] })]);
    layer.selectDrawing('d1');
    layer.setDrawings([]);
    expect(layer.selectedDrawing).toBeNull();
    expect(events).toEqual([{ type: 'select', id: null }]);
  });
});

describe('profile placement', () => {
  it('frames the span a fixed range or an anchored profile will cover while it is placed', () => {
    const axes = gridAxes();
    const range = shapeOf(
      spec({
        kind: 'profile_range',
        points: [
          { t: 10 * 60_000, price: Number.NaN },
          { t: 30 * 60_000, price: Number.NaN },
        ],
      }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(range.fills[0]!.pts.map((p) => p.x)).toEqual([95, 305, 305, 95]);
    const anchored = shapeOf(
      spec({ kind: 'profile_anchored', points: [{ t: 10 * 60_000, price: Number.NaN }] }),
      axes,
      METRICS,
      COLORS,
    )!;
    expect(anchored.fills[0]!.pts.map((p) => p.x)).toEqual([95, axes.lastBarX + 5, axes.lastBarX + 5, 95]);
  });
});

describe('crispStroke', () => {
  it('centres a stroke of odd device width on a pixel and puts an even one on a pixel edge', () => {
    expect(crispStroke(10.3, 1, 1)).toBe(10.5);
    expect(crispStroke(10.3, 2, 1)).toBe(10);
    expect(crispStroke(10.3, 1, 2)).toBe(10.5);
    expect(crispStroke(10.3, 1.5, 2)).toBe(10.75);
  });
});
