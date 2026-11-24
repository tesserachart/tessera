import { describe, expect, it } from 'vitest';
import { TESSERA_THEME, isClear, isLight, colorChannels, type Bar } from '../src/index.ts';
import { headless } from './fixtures.ts';

type Ctx = { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };

function pixel(chart: ReturnType<typeof headless>, surface: 'main' | 'overlay', x: number, y: number): number[] {
  const ctx = chart.canvases[surface].getContext('2d') as Ctx;
  return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
}

const near = (px: number[], hex: string) => {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return want.every((v, i) => Math.abs(v - px[i]!) < 24);
};

function tallBars(n: number): Bar[] {
  const t0 = Date.UTC(2026, 9, 2, 13, 30);
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * 300_000, o: 100, h: 110, l: 90, c: 104, v: 1000 }));
}

describe('the chart theme', () => {
  it('draws wicks and body edges in their own colours, and the bodies inside them', () => {
    const chart = headless({
      initialBars: 12,
      theme: { upFill: '#203040', upWick: '#ff0000', upBorder: '#00ff00' },
    });
    chart.setData('main', tallBars(12));
    chart.render(true);
    const c = chart.coords();
    const x = c.xOfIndex(6);
    expect(near(pixel(chart, 'main', x, c.yOfPrice(108)), '#ff0000')).toBe(true);
    expect(near(pixel(chart, 'main', x + 2, c.yOfPrice(102)), '#203040')).toBe(true);
    const half = Math.floor((c.barSpacing * 0.7) / 2);
    expect(near(pixel(chart, 'main', x - half, c.yOfPrice(102)), '#00ff00')).toBe(true);
    chart.destroy();
  });

  it('draws the vertical grid at the time labels only when it has a colour', () => {
    const chart = headless({ initialBars: 60 });
    chart.setData('main', tallBars(60));
    chart.render(true);
    const c = chart.coords();
    const y = c.plot.y + 4;
    const column = (colour: string) => {
      let hits = 0;
      for (let x = c.plot.x; x < c.plot.x + c.plot.w; x++) if (near(pixel(chart, 'main', x, y), colour)) hits++;
      return hits;
    };
    expect(column('#ff00ff')).toBe(0);
    chart.setOptions({ theme: { ...TESSERA_THEME, gridVertical: '#ff00ff' } });
    chart.render(true);
    expect(column('#ff00ff')).toBeGreaterThan(1);
    chart.setOptions({ theme: { ...TESSERA_THEME, background: '#123456' } });
    chart.render(true);
    expect(chart.theme.background).toBe('#123456');
    expect(column('#ff00ff')).toBe(0);
    chart.destroy();
  });

  it('reads every colour form the theme may hold', () => {
    expect(colorChannels('#abc')).toEqual([170, 187, 204, 1]);
    expect(colorChannels('#11223380')?.[3]).toBeCloseTo(0.502, 2);
    expect(colorChannels('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
    expect(colorChannels('red')).toBeNull();
    expect(isClear('#dcebef00')).toBe(true);
    expect(isClear('rgba(220,236,240,0)')).toBe(true);
    expect(isClear('#dcebef08')).toBe(false);
    expect(isLight('#eef3f4cc')).toBe(true);
    expect(isLight('#111824')).toBe(false);
    expect(isClear(TESSERA_THEME.gridVertical)).toBe(true);
  });
});
