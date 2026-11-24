import { type createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  FootprintStore,
  StackedImbalanceLayer,
  stackRowTicks,
  TickGrid,
  type Bar,
  type FootprintInput,
  type StackedImbalanceOptions,
} from '../src/index.ts';
import { headless } from './fixtures.ts';

const TICK = 0.25;
const GRID = new TickGrid(TICK);
const T0 = Date.UTC(2026, 9, 5, 13, 30);
const MIN = 60_000;
const BASE = GRID.toTick(5800);
const STACK_BAR = 5;

function market(touchAt: number | null): { bars: Bar[]; footprints: FootprintInput[] } {
  const bars: Bar[] = [];
  const footprints: FootprintInput[] = [];
  for (let i = 0; i < 12; i++) {
    const t = T0 + i * MIN;
    const lo = i === STACK_BAR || i === touchAt ? BASE : BASE + 10;
    const cells: [number, number, number][] = [];
    for (let r = 0; r < 10; r++) {
      const stacked = i === STACK_BAR && r >= 1 && r <= 3;
      const under = i === STACK_BAR && r <= 2;
      cells.push([GRID.toPrice(lo + r), under ? 10 : 20, stacked ? 60 : 20]);
    }
    const v = cells.reduce((n, c) => n + c[1] + c[2], 0);
    bars.push({ t, o: GRID.toPrice(lo + 4), h: GRID.toPrice(lo + 9), l: GRID.toPrice(lo), c: GRID.toPrice(lo + 5), v });
    footprints.push({ t, row: TICK, cells, deltaHigh: null, deltaLow: null });
  }
  return { bars, footprints };
}

function drawn(touchAt: number | null, options: Partial<StackedImbalanceOptions> = {}, spacing = 12) {
  const { bars, footprints } = market(touchAt);
  const chart = headless({
    timeframeMs: MIN,
    priceFormat: { precision: 2, minMove: TICK },
    sessions: { mode: 'continuous', timezone: 'UTC', dayStartMinutes: 0 },
    rightPadBars: 2,
  });
  chart.setData('main', bars);
  chart.setLayerVisible('grid', false);
  const store = new FootprintStore(GRID);
  store.setHistory(footprints);
  const layer = new StackedImbalanceLayer({ id: 'si', options: { rowTicks: 1, ...options } });
  layer.setStore(store);
  chart.addLayer(layer);
  chart.setViewport({ barSpacing: spacing });
  chart.render(true);
  const c = chart.coords();
  const under = chart.canvases.underlay.getContext('2d') as ReturnType<ReturnType<typeof createCanvas>['getContext']>;
  const y = Math.round(c.yOfPrice(GRID.toPrice(BASE + 2)));
  const ink = (i: number) => under.getImageData(Math.round(c.xOfIndex(i)), y, 1, 1).data[3]!;
  return { chart, layer, ink };
}

describe('stacked imbalance study', () => {
  it('draws its zones on plain candles, with the footprint off, at any zoom', () => {
    for (const spacing of [3, 12, 40]) {
      const { chart, ink } = drawn(null, {}, spacing);
      expect(ink(STACK_BAR - 1)).toBe(0);
      expect(ink(8)).toBeGreaterThan(0);
      expect(ink(11)).toBeGreaterThan(0);
      chart.destroy();
    }
  });

  it('ends a zone at the bar that trades back into it, and hides it when tested zones are off', () => {
    const tested = drawn(8);
    expect(tested.ink(7)).toBeGreaterThan(0);
    expect(tested.ink(10)).toBe(0);
    tested.chart.destroy();
    const open = drawn(8, { tested: false });
    expect(open.ink(7)).toBe(0);
    open.chart.destroy();
  });

  it('needs a stack at least as tall as its minimum and an imbalance at its ratio', () => {
    const tall = drawn(null, { stackRows: 4 });
    expect(tall.ink(8)).toBe(0);
    tall.chart.destroy();
    const strict = drawn(null, { ratio: 8 });
    expect(strict.ink(8)).toBe(0);
    strict.chart.destroy();
  });

  it('finds stacks on the contract rows when the row size is auto, and says how tall those rows are', () => {
    expect(stackRowTicks({ rowTicks: 'auto', minRowTicks: 4 })).toBe(4);
    expect(stackRowTicks({ rowTicks: 2, minRowTicks: 4 })).toBe(2);
    const layer = new StackedImbalanceLayer({ id: 'x', options: { rowTicks: 'auto', minRowTicks: 4 } });
    expect(layer.legendSuffix()).toBe('4 ticks');
    layer.setOptions({ rowTicks: 1 });
    expect(layer.legendSuffix()).toBe('');
  });

  it('asks for footprints from the first bar shown, zoomed out or in', () => {
    const { chart, layer } = drawn(null, {}, 3);
    const c = chart.coords();
    expect(layer.needFrom).toBe(T0 + c.from * MIN);
    chart.destroy();
  });
});
