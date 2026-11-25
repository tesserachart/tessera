import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  FOOTPRINT_TEXT,
  GLYPH_CACHE_BYTES,
  GLYPHS,
  GlyphAtlas,
  TESSERA_THEME,
  formatCount,
  type Ctx2D,
} from '../src/index.ts';

const COLORS = [
  `rgba(238,243,244,${String(FOOTPRINT_TEXT.alpha)})`,
  TESSERA_THEME.upText,
  TESSERA_THEME.downText,
  TESSERA_THEME.mutedText,
];

const atlas = (dpr = 2, cacheBytes?: number) =>
  new GlyphAtlas({
    createCanvas: (w, h) => createCanvas(w, h),
    family: TESSERA_THEME.fontFig,
    size: 11.5,
    colors: COLORS,
    dpr,
    ...(cacheBytes === undefined ? {} : { cacheBytes }),
  });

describe('formatCount', () => {
  it('prints counts as the footprint cell does', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(7)).toBe('7');
    expect(formatCount(9999)).toBe('9,999');
    expect(formatCount(10_000)).toBe('10k');
    expect(formatCount(12_449)).toBe('12.4k');
    expect(formatCount(12_450)).toBe('12.5k');
    expect(formatCount(99_960)).toBe('100k');
    expect(formatCount(1_240_000)).toBe('1,240k');
    expect(formatCount(-312)).toBe('−312');
    expect(formatCount(312, true)).toBe('+312');
    expect(formatCount(0, true)).toBe('0');
    expect(formatCount(-12_400, true)).toBe('−12.4k');
    expect(formatCount(0.125)).toBe('0.13');
    expect(formatCount(12.5)).toBe('12.5');
    expect(formatCount(Number.NaN)).toBe('');
  });
});

type Pixels = { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };

function inkSpan(canvas: Canvas, dpr: number, y0: number, y1: number): [number, number] | null {
  const ctx = canvas.getContext('2d') as unknown as Pixels;
  const { data } = ctx.getImageData(0, Math.round(y0 * dpr), canvas.width, Math.round((y1 - y0) * dpr));
  let lo = Infinity;
  let hi = -Infinity;
  const w = canvas.width;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > 40) {
      const x = ((i - 3) / 4) % w;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return lo <= hi ? [lo / dpr, (hi + 1) / dpr] : null;
}

describe('GlyphAtlas', () => {
  it('holds glyphs of one UTF-16 unit each, as it indexes them by char code', () => {
    expect(Array.from(GLYPHS).every((c) => c.length === 1)).toBe(true);
  });

  it('gives every digit one advance and knows which strings it can draw', () => {
    const a = atlas();
    expect(a.digit).toBeGreaterThan(4);
    expect(a.measure('1')).toBe(a.measure('8'));
    expect(a.measure('1,234')).toBeCloseTo(4 * a.digit + a.measure(','), 6);
    expect(a.holds('−12.4k')).toBe(true);
    expect(a.holds('+312×9')).toBe(true);
    expect(a.holds('12M')).toBe(false);
    expect(a.bytes).toBeLessThan(1024 * 1024);
  });

  it('blits a string aligned on x, on whole device pixels', () => {
    const dpr = 2;
    const a = atlas(dpr);
    const canvas = createCanvas(200 * dpr, 40 * dpr);
    const ctx = canvas.getContext('2d') as unknown as Ctx2D;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    a.draw(ctx, '1,234', 100, 10, 'right');
    a.draw(ctx, '56', 100, 30, 'left', 1, 1);
    const right = inkSpan(canvas, dpr, 2, 18)!;
    expect(right[1]).toBeLessThanOrEqual(100.5);
    expect(right[1]).toBeGreaterThan(97);
    expect(right[0]).toBeGreaterThan(100 - a.measure('1,234') - 1.5);
    const left = inkSpan(canvas, dpr, 22, 38)!;
    expect(left[0]).toBeGreaterThanOrEqual(99.5);
    expect(left[0]).toBeLessThan(103);
    const { data } = (canvas.getContext('2d') as unknown as Pixels).getImageData(
      Math.round(left[0] * dpr),
      22 * dpr,
      Math.round((left[1] - left[0]) * dpr),
      16 * dpr,
    );
    let best = 3;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > data[best]!) best = i;
    expect(data[best - 2]!).toBeGreaterThan(data[best - 3]!);
  });

  it('centres a string on x', () => {
    const dpr = 1;
    const a = atlas(dpr);
    const canvas = createCanvas(200, 30);
    const ctx = canvas.getContext('2d') as unknown as Ctx2D;
    a.draw(ctx, '888', 100, 15, 'center');
    const [lo, hi] = inkSpan(canvas, dpr, 5, 25)!;
    expect(Math.abs((lo + hi) / 2 - 100)).toBeLessThan(1.5);
  });

  it('draws a cached string on the same pixels as glyph by glyph', () => {
    const dpr = 2;
    const draw = (a: GlyphAtlas) => {
      const canvas = createCanvas(160 * dpr, 30 * dpr);
      const ctx = canvas.getContext('2d') as unknown as Ctx2D;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let pass = 0; pass < 2; pass++) {
        a.beginFrame();
        a.draw(ctx, '12.4k', 60, 15, 'right', 2, 1);
        a.draw(ctx, '−1,234', 70, 15, 'left');
      }
      return (canvas.getContext('2d') as unknown as Pixels).getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const cached = atlas(dpr);
    const direct = atlas(dpr, 0);
    const a = draw(cached);
    expect(cached.cached).toBe(2);
    expect(direct.cacheBytes).toBe(0);
    expect(Buffer.from(a).equals(Buffer.from(draw(direct)))).toBe(true);
  });

  it('draws glyph by glyph once the cache is full, and starts over after a frame that mostly missed', () => {
    const a = atlas(1, 2048 * 4 * 20);
    const canvas = createCanvas(400, 400);
    const ctx = canvas.getContext('2d') as unknown as Ctx2D;
    a.beginFrame();
    const strings = Array.from({ length: 400 }, (_, k) => formatCount(1000 + k * 7));
    strings.forEach((t, k) => {
      a.draw(ctx, t, 10 + (k % 10) * 38, 10 + Math.floor(k / 10) * 9, 'left');
    });
    const held = a.cached;
    expect(held).toBeGreaterThan(10);
    expect(held).toBeLessThan(400);
    expect(inkSpan(canvas, 1, 355, 368)).not.toBeNull();
    a.beginFrame();
    expect(a.cached).toBe(0);
    a.draw(ctx, strings[399]!, 10, 10, 'left');
    expect(a.cached).toBe(1);
  });

  it('keeps no cache until a string arrives, then grows it a page at a time within its budget', () => {
    const a = atlas(2);
    expect(a.cacheBytes).toBe(0);
    const canvas = createCanvas(400, 400);
    const ctx = canvas.getContext('2d') as unknown as Ctx2D;
    a.beginFrame();
    a.draw(ctx, '1,234', 10, 10, 'left');
    const page = a.cacheBytes;
    expect(page).toBeGreaterThan(0);
    expect(page).toBeLessThanOrEqual(GLYPH_CACHE_BYTES / 4);
    for (let k = 0; k < 3000; k++) a.draw(ctx, formatCount(1000 + k * 3), 10, 10, 'left');
    expect(a.cacheBytes).toBeGreaterThan(page);
    expect(a.cacheBytes).toBeLessThanOrEqual(GLYPH_CACHE_BYTES);
  });

  it('draws a prepared string on the same pixels without composing it again', () => {
    const dpr = 2;
    const draw = (prepared: boolean) => {
      const a = atlas(dpr);
      const canvas = createCanvas(160 * dpr, 30 * dpr);
      const ctx = canvas.getContext('2d') as unknown as Ctx2D;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      a.beginFrame();
      if (prepared) {
        a.prepare('12.4k', 2, 1);
        a.prepare('−1,234');
        expect(a.cached).toBe(2);
      }
      a.draw(ctx, '12.4k', 60, 15, 'right', 2, 1);
      a.draw(ctx, '−1,234', 70, 15, 'left');
      expect(a.cached).toBe(2);
      return (canvas.getContext('2d') as unknown as Pixels).getImageData(0, 0, canvas.width, canvas.height).data;
    };
    expect(Buffer.from(draw(true)).equals(Buffer.from(draw(false)))).toBe(true);
  });

  it('draws a string that is not reusable without keeping it', () => {
    const a = atlas(1);
    const canvas = createCanvas(200, 30);
    const ctx = canvas.getContext('2d') as unknown as Ctx2D;
    a.beginFrame();
    a.draw(ctx, '1,234', 10, 15, 'left', 0, 0, false);
    expect(a.cached).toBe(0);
    expect(inkSpan(canvas, 1, 5, 25)).not.toBeNull();
    a.draw(ctx, '1,234', 10, 15, 'left');
    expect(a.cached).toBe(1);
  });
});
