import { describe, expect, it } from 'vitest';
import { PriceFormatter, TESSERA_THEME, isLight, mergeTheme, niceStep } from '../src/index.ts';
import { equityBars, headless } from './fixtures.ts';

describe('the chart theme', () => {
  it('never draws prices smaller than it can read', () => {
    expect(mergeTheme(TESSERA_THEME, { priceFontSize: 8 }).priceFontSize).toBe(11);
  });
});

describe('the axis in the system’s format', () => {
  it('groups by thousands and drops the decimals on a whole step', () => {
    const f = new PriceFormatter({ precision: 2, minMove: 0.25 });
    expect(f.axis(20650, 50)).toBe('20,650');
    expect(f.axis(20647.5, 2.5)).toBe('20,647.50');
    expect(f.axis(20650, 2.5)).toBe('20,650.00');
    expect(f.axis(-1250, 10)).toBe('−1,250');
    expect(niceStep(37)).toBe(50);
    expect(niceStep(21)).toBe(25);
    expect(niceStep(0.3)).toBe(0.5);
  });

  it('tells a light tag from a dark one, so the ink is readable on both', () => {
    expect(isLight('#eef3f4')).toBe(true);
    expect(isLight('#111824')).toBe(false);
    expect(isLight('rgba(5,7,12,1)')).toBe(false);
    expect(isLight('#5fc79c')).toBe(true);
  });

  it('labels the price axis and the time axis in the UI sans (prices at 12 px)', () => {
    const chart = headless();
    chart.setData('main', equityBars(3));
    const fonts = new Map<string, string[]>();
    const ctx = chart.canvases.main.getContext('2d') as {
      fillText: (t: string, x: number, y: number) => void;
      font: string;
    };
    const fill = ctx.fillText.bind(ctx);
    ctx.fillText = (t: string, x: number, y: number) => {
      fonts.set(ctx.font, [...(fonts.get(ctx.font) ?? []), t]);
      fill(t, x, y);
    };
    chart.render();
    const fig = [...fonts.entries()].find(([f]) => /\b12px /.test(f) && f.includes('Instrument Sans'));
    const sans = [...fonts.entries()].find(([f]) => /\b11.5px\b/.test(f) && f.includes('Instrument Sans'));
    expect(fig?.[0]).toMatch(/\b12px /);
    expect(fig?.[1].every((t) => /^[\d,]+(\.\d+)?$/.test(t))).toBe(true);
    expect(sans?.[1].some((t) => /^\d\d:\d\d$/.test(t))).toBe(true);
    chart.destroy();
  });
});
