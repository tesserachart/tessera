import { describe, expect, it } from 'vitest';
import { PriceFormatter, PriceScale, TimeScale } from '../src/index.ts';

describe('PriceScale', () => {
  it('maps price ↔ y and round-trips', () => {
    const s = new PriceScale();
    s.setPane(0, 400);
    s.mode = 'manual';
    s.min = 480;
    s.max = 490;
    expect(s.yOf(490)).toBe(0);
    expect(s.yOf(480)).toBe(400);
    expect(s.yOf(485)).toBe(200);
    for (const p of [480.13, 487.85, 489.99]) expect(s.priceOf(s.yOf(p))).toBeCloseTo(p, 9);
  });

  it('auto-fits with padding and handles flat data', () => {
    const s = new PriceScale();
    s.setPane(0, 100);
    s.autoFit(485.52, 489.22, 0.1);
    expect(s.yOf(489.22)).toBeCloseTo(8, 6);
    expect(s.yOf(485.52)).toBeCloseTo(92, 6);
    s.autoFit(100, 100, 1);
    expect(s.max - s.min).toBeGreaterThan(1);
    expect((s.max + s.min) / 2).toBeCloseTo(100, 9);
  });

  it('does not auto-fit in manual mode', () => {
    const s = new PriceScale();
    s.setRange(1, 2);
    s.autoFit(10, 20, 0.1);
    expect([s.min, s.max]).toEqual([1, 2]);
  });

  it('nice tick steps respect minMove (ticks are multiples of it)', () => {
    const s = new PriceScale();
    s.setPane(0, 600);
    s.setRange(484.5, 490.5);
    const step = s.tickStep(40, 0.01);
    expect([0.25, 0.5]).toContain(step);
    const ticks = s.ticks(step, 2);
    expect(ticks[0]).toBeGreaterThanOrEqual(484.5);
    expect(ticks.at(-1)).toBeLessThanOrEqual(490.5);
    for (const t of ticks) expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);
    s.setRange(20640, 20641);
    expect(s.tickStep(40, 0.25)).toBeGreaterThanOrEqual(0.25);
    expect((s.tickStep(40, 0.25) / 0.25) % 1).toBe(0);
  });

  it('scaleAround and panPixels switch to manual mode', () => {
    const s = new PriceScale();
    s.setPane(0, 100);
    s.autoFit(0, 100, 1);
    s.scaleAround(2, 50);
    expect(s.mode).toBe('manual');
    expect((s.min + s.max) / 2).toBeCloseTo(50, 9);
    const span = s.max - s.min;
    s.panPixels(50);
    expect(s.max - s.min).toBeCloseTo(span, 9);
  });
});

describe('TimeScale', () => {
  it('maps slots to x with the right edge anchored', () => {
    const t = new TimeScale();
    t.setWidth(1000);
    t.barSpacing = 10;
    t.rightEdgeSlot = 100;
    expect(t.xOfSlot(100)).toBe(1000);
    expect(t.xOfSlot(90)).toBe(900);
    expect(t.slotOfX(900)).toBe(90);
    expect(t.leftEdgeSlot).toBe(0);
  });

  it('zoom keeps the anchor slot under the cursor', () => {
    const t = new TimeScale();
    t.setWidth(1000);
    t.barSpacing = 10;
    t.rightEdgeSlot = 100;
    const before = t.slotOfX(400);
    t.zoom(2, 400);
    expect(t.barSpacing).toBe(20);
    expect(t.slotOfX(400)).toBeCloseTo(before, 9);
    t.zoom(1e9, 400);
    expect(t.barSpacing).toBe(t.maxSpacing);
  });

  it('pan and clamp keep data on screen', () => {
    const t = new TimeScale();
    t.setWidth(1000);
    t.barSpacing = 10;
    t.rightEdgeSlot = 100;
    t.panPixels(100);
    expect(t.rightEdgeSlot).toBe(90);
    t.rightEdgeSlot = -500;
    t.clampTo(0, 200, 2);
    expect(t.rightEdgeSlot).toBe(2);
    t.rightEdgeSlot = 10_000;
    t.clampTo(0, 200, 2);
    expect(t.rightEdgeSlot).toBe(200 + 98);
  });
});

describe('PriceFormatter', () => {
  it('formats at precision with a true minus and rounds to tick', () => {
    const f = new PriceFormatter({ precision: 2, minMove: 0.25 });
    expect(f.format(20641.25)).toBe('20641.25');
    expect(f.format(-3)).toBe('−3.00');
    expect(f.signed(31.75)).toBe('+31.75');
    expect(f.signed(-0.001)).toBe('0.00');
    expect(f.round(20641.37)).toBe(20641.25);
  });
});
