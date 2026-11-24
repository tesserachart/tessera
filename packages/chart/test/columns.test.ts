import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  eachBar,
  eachColumnRange,
  PixelColumns,
  traceSeries,
  TwoToneRects,
  type ColumnRange,
  type RectFill,
} from '../src/render/columns.ts';
import type { TimeView } from '../src/layers/types.ts';
import { continuousBars, headless } from './fixtures.ts';

function view(n: number, spacing: number, x0 = 10): TimeView {
  return {
    from: 0,
    to: n - 1,
    barSpacing: spacing,
    xOfIndex: (i) => x0 + i * spacing,
    indexOfX: (x) => Math.round((x - x0) / spacing),
    xOfTime: () => Number.NaN,
  };
}

function frame(n: number, spacing: number, dpr: number) {
  const time = view(n, spacing);
  return { time, dpr, columns: new PixelColumns().measure(time, dpr) };
}

function traced(
  rc: ReturnType<typeof frame>,
  values: readonly number[],
  breakBefore: ((i: number) => boolean) | null = null,
  penWidth = 0,
) {
  const points: { i: number; v: number; start: boolean }[] = [];
  traceSeries(
    rc,
    values.length - 1,
    (i) => values[i]!,
    breakBefore,
    (i, v, start) => points.push({ i, v, start }),
    penWidth,
  );
  return points;
}

describe('pixel columns', () => {
  it('leaves bars of 1.5 device pixels or wider to be drawn one by one', () => {
    expect(frame(100, 1.5, 1).columns).toBeNull();
    expect(frame(100, 0.75, 2).columns).toBeNull();
    expect(frame(100, 1.4, 1).columns).not.toBeNull();
  });

  it('puts every visible bar in exactly one device-pixel column, left to right', () => {
    const { columns } = frame(10_000, 0.07, 2);
    const c = columns!;
    let next = 0;
    for (let k = 0; k < c.count; k++) {
      expect(c.first[k]).toBe(next);
      expect(c.last[k]).toBeGreaterThanOrEqual(c.first[k]!);
      if (k > 0) expect(c.left[k]! - c.left[k - 1]!).toBeCloseTo(0.5, 9);
      next = c.last[k]! + 1;
    }
    expect(next).toBe(10_000);
    expect(c.count).toBe(Math.floor((10 + 9_999 * 0.07) * 2) - 20 + 1);
  });
});

describe('traceSeries', () => {
  const n = 4_000;
  const values = Array.from({ length: n }, (_, i) => Math.sin(i / 50));
  values[1_234] = 9;
  values[2_345] = -9;

  it('keeps the highest and lowest value of every column', () => {
    const rc = frame(n, 0.1, 1);
    const points = traced(rc, values);
    const c = rc.columns!;
    expect(points.length).toBeLessThanOrEqual(4 * c.count);
    for (let k = 0; k < c.count; k++) {
      const own = values.slice(c.first[k], c.last[k]! + 1);
      const drawn = points.filter((p) => p.i >= c.first[k]! && p.i <= c.last[k]!).map((p) => p.v);
      expect(Math.max(...drawn)).toBe(Math.max(...own));
      expect(Math.min(...drawn)).toBe(Math.min(...own));
    }
    expect(points.some((p) => p.v === 9)).toBe(true);
    expect(points.some((p) => p.v === -9)).toBe(true);
  });

  it('traces points in bar order, ending on the last bar', () => {
    const points = traced(frame(n, 0.1, 1), values);
    for (let k = 1; k < points.length; k++) expect(points[k]!.i).toBeGreaterThan(points[k - 1]!.i);
    expect(points.at(-1)!.i).toBe(n - 1);
    expect(points.filter((p) => p.start)).toHaveLength(1);
  });

  it('lifts the pen across a gap and at a break inside a column', () => {
    const gapped = values.map((v, i) => (i >= 1_000 && i < 1_003 ? Number.NaN : v));
    const points = traced(frame(n, 0.1, 1), gapped, (i) => i === 3_001);
    const starts = points.filter((p) => p.start).map((p) => p.i);
    expect(starts).toEqual([0, 1_003, 3_001]);
    expect(points.some((p) => p.i >= 1_000 && p.i < 1_003)).toBe(false);
  });

  it('keeps the highest and lowest value of every pen-wide run of columns, with fewer points', () => {
    const rc = frame(n, 0.05, 2);
    const c = rc.columns!;
    const points = traced(rc, values, null, 1.25);
    expect(points.length).toBeLessThan(traced(rc, values).length / 2);
    const run = (k: number) => Math.floor(Math.round(c.left[k]! * 2) / 3);
    for (let k = 0; k < c.count;) {
      let end = k;
      while (end + 1 < c.count && run(end + 1) === run(k)) end++;
      const own = values.slice(c.first[k], c.last[end]! + 1);
      const drawn = points.filter((p) => p.i >= c.first[k]! && p.i <= c.last[end]!).map((p) => p.v);
      expect(Math.max(...drawn)).toBe(Math.max(...own));
      expect(Math.min(...drawn)).toBe(Math.min(...own));
      k = end + 1;
    }
    expect(points.map((p) => p.v)).toEqual(expect.arrayContaining([9, -9]));
    expect(points.at(-1)!.i).toBe(n - 1);
  });

  it('traces every bar when bars are wide', () => {
    const wide = [1, 2, Number.NaN, 4, 5];
    const points = traced(frame(5, 8, 2), wide, (i) => i === 4);
    expect(points).toEqual([
      { i: 0, v: 1, start: true },
      { i: 1, v: 2, start: false },
      { i: 3, v: 4, start: true },
      { i: 4, v: 5, start: true },
    ]);
  });
});

describe('eachBar', () => {
  it('draws the tallest and the deepest bar of each column at the column', () => {
    const values = Array.from({ length: 400 }, (_, i) => (i % 2 ? -(i % 7) : i % 5));
    const rc = frame(values.length, 0.2, 1);
    const drawn: { i: number; x: number }[] = [];
    eachBar(
      rc,
      values.length - 1,
      (i) => values[i]!,
      (i, x) => drawn.push({ i, x }),
    );
    const c = rc.columns!;
    for (let k = 0; k < c.count; k++) {
      const own = values.slice(c.first[k], c.last[k]! + 1);
      const here = drawn.filter((d) => d.i >= c.first[k]! && d.i <= c.last[k]!);
      for (const d of here) expect(d.x).toBe(c.left[k]! + 0.5);
      expect(Math.max(...here.map((d) => values[d.i]!))).toBe(Math.max(...own));
      expect(Math.min(...here.map((d) => values[d.i]!))).toBe(Math.min(...own));
      expect(here.length).toBeLessThanOrEqual(2);
    }
  });

  it('draws every bar with a value when bars are wide', () => {
    const drawn: number[] = [];
    eachBar(
      frame(4, 10, 1),
      3,
      (i) => [1, Number.NaN, -2, 0][i]!,
      (i) => drawn.push(i),
    );
    expect(drawn).toEqual([0, 2, 3]);
  });
});

describe('eachColumnRange', () => {
  const rc = frame(40, 0.1, 1);
  const low = Array.from({ length: 40 }, (_, i) => (i === 3 ? Number.NaN : 100 - (i % 9)));
  const high = low.map((l, i) => l + 1 + (i % 4));
  const ranges = (breakBefore: ((i: number) => boolean) | null) => {
    const out: ColumnRange[] = [];
    eachColumnRange(rc.columns!, 39, low, high, breakBefore, (r) => out.push({ ...r }));
    return out;
  };
  const span = (from: number, to: number) => {
    const idx = Array.from({ length: to - from + 1 }, (_, k) => from + k).filter((i) => !Number.isNaN(low[i]!));
    return {
      first: idx[0],
      last: idx.at(-1),
      lo: Math.min(...idx.map((i) => low[i]!)),
      hi: Math.max(...idx.map((i) => high[i]!)),
    };
  };

  it('spans the lowest low and highest high of each column, skipping bars with no value', () => {
    const out = ranges(null);
    const c = rc.columns!;
    expect(out).toHaveLength(c.count);
    for (let k = 0; k < c.count; k++) {
      expect(out[k]).toMatchObject({ left: c.left[k], ...span(c.first[k]!, c.last[k]!) });
    }
  });

  it('splits a column where a session restarts, so the range never bridges the reset', () => {
    const out = ranges((i) => i === 15);
    const c = rc.columns!;
    expect(c.first[1]).toBeLessThan(15);
    expect(c.last[1]).toBeGreaterThan(15);
    expect(out).toHaveLength(c.count + 1);
    expect(out[1]).toMatchObject(span(c.first[1]!, 14));
    expect(out[2]).toMatchObject(span(15, c.last[1]!));
  });
});

describe('TwoToneRects', () => {
  const pixels = (how: RectFill, rects: (add: TwoToneRects['add']) => void) => {
    const canvas = createCanvas(200, 100);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    ctx.scale(2, 2);
    const two = new TwoToneRects();
    rects(two.add);
    two.fill(ctx, ['rgba(95,199,156,0.26)', 'rgba(236,123,120,0.24)'], how);
    return ctx.getImageData(0, 0, 200, 100).data;
  };

  it('fills pixel-aligned columns one by one with the same pixels as one path', () => {
    const columns = (add: TwoToneRects['add']) => {
      for (let k = 0; k < 200; k++) add(k % 3 ? 0 : 1, k / 2, 50 - ((k * 7) % 45), 0.5, (k * 7) % 45);
    };
    expect(pixels('one by one', columns)).toEqual(pixels('one path', columns));
  });

  it('blends overlapping translucent rects once only as one path', () => {
    const overlapping = (add: TwoToneRects['add']) => {
      add(0, 10, 10, 0.5, 20);
      add(0, 10, 20, 0.5, 20);
    };
    const at = (data: Uint8ClampedArray) => data[(50 * 200 + 20) * 4 + 3];
    expect(at(pixels('one by one', overlapping))).toBeGreaterThan(at(pixels('one path', overlapping))!);
  });
});

describe('a chart zoomed out past one bar per pixel', () => {
  it('still shows a volume spike that is not the first bar of its pixel column', () => {
    const bars = continuousBars(6_000);
    const chart = headless({ volumePane: 0.2, timeframeMs: 60_000 });
    chart.setLayerVisible('grid', false);
    chart.setData('main', bars);
    chart.setViewport({ fitAll: true });
    chart.render(true);
    const c = chart.coords();
    const col = (i: number) => Math.floor(c.xOfIndex(i));
    let spike = 3_000;
    while (col(spike - 1) !== col(spike)) spike++;
    bars[spike] = { ...bars[spike]!, v: 10_000 };
    chart.setData('main', bars);
    chart.setViewport({ fitAll: true });
    chart.render(true);
    const pane = chart.coords().panes.find((p) => p.id === 'volume')!.rect;
    const x = col(spike);
    const ctx = chart.canvases.main.getContext('2d') as CanvasRenderingContext2D;
    const pixels = ctx.getImageData(x, pane.y, 1, pane.h).data;
    let top = 0;
    while (top < pane.h && pixels[top * 4 + 3] === 0) top++;
    expect(top).toBeLessThanOrEqual(5);
    chart.destroy();
  });
});
