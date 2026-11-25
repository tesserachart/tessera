import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { ORDERFLOW_STYLE, TESSERA_THEME } from '../src/theme.ts';
import {
  footprintRowTicks,
  BigTradesLayer,
  bigTradeCard,
  bigTradeLabelFont,
  fitBubbleLabel,
  sizeSpellings,
  overlapShare,
  bigTradeOutcomeWords,
  bigTradeWords,
  bubbleRadius,
  DeltaLayer,
  DELTA_COLUMNS,
  FootprintLayer,
  FootprintStore,
  LegendLayer,
  PriceFormatter,
  TickGrid,
  VolumeProfileLayer,
  formatCount,
  signedCount,
  type Bar,
  type BigTrade,
  type BigTradeMarker,
  type DeltaOptions,
  type DeltaStyle,
  type FootprintInput,
  type FootprintMaxLevel,
  type FootprintMode,
  type FootprintOptions,
  type PlotStyle,
  type SeriesValues,
  type ProfileShow,
  type SessionProfileData,
} from '../src/index.ts';
import { CANDLE_BODY_MIN_SPACING } from '../src/layers/candles.ts';
import { FOOTPRINT_FIGURE_SIZES, STEM_BODY_PX, STEM_X_PX } from '../src/layers/footprint.ts';
import { deltaShare, priceAgainstDelta } from '../src/layers/delta.ts';
import { barsMissingPrints } from '../src/layers/missingPrints.ts';
import { headless, rng, valuesOf } from './fixtures.ts';

const TICK = 0.25;
const FMT = new PriceFormatter({ precision: 2, minMove: 0.25 });
const GRID = new TickGrid(TICK);
const T0 = Date.UTC(2026, 9, 5, 13, 30);
const MIN = 60_000;

function market(n: number, seed = 5): { bars: Bar[]; footprints: FootprintInput[] } {
  const r = rng(seed);
  const bars: Bar[] = [];
  const footprints: FootprintInput[] = [];
  let p = 5800;
  for (let i = 0; i < n; i++) {
    const t = T0 + i * MIN;
    const lo = GRID.toTick(p) - Math.floor(r() * 8);
    const hi = GRID.toTick(p) + Math.floor(r() * 8);
    const cells: [number, number, number, number][] = [];
    let delta = 0;
    let run = 0;
    let dh = 0;
    let dl = 0;
    for (let k = lo; k <= hi; k++) {
      const bid = Math.floor(r() * 120);
      const ask = Math.floor(r() * 120);
      cells.push([GRID.toPrice(k), bid, ask, bid + ask > 0 ? 1 + ((bid * 7 + ask * 3) % 23) : 0]);
      delta += ask - bid;
      run += ask - bid;
      dh = Math.max(dh, run);
      dl = Math.min(dl, run);
    }
    const o = GRID.toPrice(lo + Math.floor(r() * (hi - lo + 1)));
    const c = GRID.toPrice(lo + Math.floor(r() * (hi - lo + 1)));
    let v = 0;
    for (const cell of cells) v += cell[1] + cell[2];
    bars.push({ t, o, h: GRID.toPrice(hi), l: GRID.toPrice(lo), c, v });
    footprints.push({ t, row: TICK, cells, deltaHigh: Math.max(dh, delta), deltaLow: Math.min(dl, delta) });
    p = c;
  }
  return { bars, footprints };
}

function cvdOf(bars: readonly Bar[], footprints: readonly FootprintInput[], from = 0): SeriesValues {
  let total = 0;
  const rows = footprints.map((f) => {
    let delta = 0;
    let volume = 0;
    for (const [, bid, ask] of f.cells) {
      delta += ask - bid;
      volume += bid + ask;
    }
    const open = total;
    total += delta;
    const { deltaHigh, deltaLow } = f;
    const known = deltaHigh !== null && deltaLow !== null;
    return {
      delta,
      volume,
      open,
      close: total,
      high: open + Math.max(0, deltaHigh ?? delta, delta),
      low: open + Math.min(0, deltaLow ?? delta, delta),
      candle: known ? 1 : 0,
    };
  });
  const N = Number.NaN;
  return valuesOf(
    bars,
    Object.fromEntries(DELTA_COLUMNS.map((k) => [k, (_b: Bar, i: number) => (i < from ? N : rows[i]![k])])),
  );
}

function chartWith(bars: Bar[], extra: Parameters<typeof headless>[0] = {}) {
  const chart = headless({
    timeframeMs: MIN,
    priceFormat: { precision: 2, minMove: TICK },
    sessions: { mode: 'continuous', timezone: 'UTC', dayStartMinutes: 0 },
    ...extra,
  });
  chart.setData('main', bars);
  return chart;
}

const style = (color: string, extra: Partial<PlotStyle> = {}): PlotStyle => ({
  color,
  downColor: null,
  width: 1,
  line: 'solid',
  opacity: 1,
  visible: true,
  ...extra,
});

describe('footprint layer', () => {
  it('steps through its levels of detail at the stated spacings, with 4 px of hysteresis', () => {
    const { bars, footprints } = market(120);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    const at = (spacing: number) => {
      chart.setViewport({ barSpacing: spacing });
      chart.render();
      return fp.lod;
    };
    expect(at(8)).toBe(0);
    expect(at(14)).toBe(1);
    expect(at(11)).toBe(1);
    expect(at(9.5)).toBe(0);
    expect(at(12)).toBe(0);
    expect(at(140)).toBe(3);
    expect(at(94)).toBe(3);
    expect(at(91)).toBe(2);
    expect(at(94)).toBe(2);
    expect(at(96)).toBe(3);
    expect(fp.viewHints().maxBarSpacing).toBe(480);
    chart.destroy();
  });

  it('steps its figures down a size or two before the cells take over, keeping each inside its bar, with no flicker at a step', () => {
    const { bars, footprints } = market(40);
    const busy = footprints.map((f) => ({
      ...f,
      cells: f.cells.map(([price, bid, ask]): [number, number, number] => [price, 1000 + 7 * bid, 1000 + 7 * ask]),
    }));
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(busy);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h), options: { rowTicks: 1 } });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ price: { min: 5795, max: 5805 } });
    const at = (spacing: number) => {
      chart.setViewport({ barSpacing: spacing });
      chart.render();
      return fp.lod >= 2 ? fp.figureSize : null;
    };
    const steps: { spacing: number; size: number | null }[] = [];
    let last: number | null | undefined;
    for (let spacing = 120; spacing >= 40; spacing -= 0.5) {
      const size = at(spacing);
      if (size !== last && last !== undefined) {
        expect(at(spacing + 1), `a 1 px wiggle at the ${String(spacing)} px step holds`).toBe(size);
        expect(at(spacing)).toBe(size);
      }
      if (size !== last) steps.push({ spacing, size });
      last = size;
      if (size === null) continue;
      const c = chart.coords();
      const rc = (fp as unknown as { lastRc: Parameters<FootprintLayer['figureColumns']>[0] }).lastRc;
      for (const col of fp.figureColumns(rc)) {
        const x = c.xOfIndex(col.index);
        expect(col.left, `${String(spacing)} px`).toBeGreaterThanOrEqual(x - spacing / 2);
        expect(col.right, `${String(spacing)} px`).toBeLessThanOrEqual(x + spacing / 2);
      }
    }
    expect(steps.map((s) => s.size)).toEqual([...FOOTPRINT_FIGURE_SIZES, null]);
    const fullGone = steps[1]!.spacing;
    const numbersGone = steps.at(-1)!.spacing;
    expect(numbersGone, 'the smaller figures hold about an eighth further out').toBeLessThan(fullGone * 0.88);
    const back: { spacing: number; size: number | null }[] = [];
    last = null;
    for (let spacing = 40; spacing <= 120; spacing += 0.5) {
      const size = at(spacing);
      if (size !== last) back.push({ spacing, size });
      last = size;
    }
    expect(back.map((s) => s.size)).toEqual([...[...FOOTPRINT_FIGURE_SIZES].reverse()]);
    back.forEach((up, k) => expect(up.spacing).toBeGreaterThan(steps[steps.length - 1 - k]!.spacing));
    chart.destroy();
  });

  it('draws plain candles where the footprint history has not reached', () => {
    const { bars, footprints } = market(60);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints.slice(40));
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 30, lastBars: 30 });
    expect(() => chart.render()).not.toThrow();
    expect(fp.lod).toBe(1);
    fp.setStore(new FootprintStore(GRID));
    chart.render();
    chart.destroy();
  });

  it('merges rows automatically and says so in its label', () => {
    const { bars, footprints } = market(80);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 20 });
    chart.setViewport({ price: { min: 5700, max: 5900 } });
    chart.render();
    expect(fp.lod).toBe(1);
    expect(fp.rowTicks).toBeGreaterThan(1);
    expect(fp.legendSuffix()).toBe(`${String(fp.rowTicks)} ticks`);
    fp.setOptions({ rowTicks: 1 });
    chart.render();
    expect(fp.legendSuffix()).toBe('');
    chart.destroy();
  });

  it('paints the mid-zoom cells as a split of bid and ask bars when the figures cannot fit, so the rows still read', () => {
    const { bars, footprints } = market(60);
    const hues = (mode: FootprintMode) => {
      const chart = chartWith(bars);
      const store = new FootprintStore(GRID);
      store.setHistory(footprints);
      const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h), options: { mode } });
      fp.setStore(store);
      chart.addLayer(fp);
      chart.setViewport({ barSpacing: 30 });
      chart.render(true);
      expect(fp.lod).toBe(1);
      const ctx = chart.canvases.main.getContext('2d') as {
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
      const { width: w, height: h } = chart.canvases.main;
      const d = ctx.getImageData(0, 0, w, h).data;
      let blue = 0;
      let orange = 0;
      for (let k = 0; k < d.length; k += 4) {
        const r = d[k]!;
        const b = d[k + 2]!;
        if (b > r + 40 && b > 120) blue++;
        if (r > b + 40 && r > 120) orange++;
      }
      chart.destroy();
      return blue + orange;
    };
    expect(hues('bid_ask'), 'the split bars carry the rows').toBeGreaterThan(hues('volume') + 500);
  });

  it('measures each bar: its delta POC, value area and unfinished auctions', () => {
    const store = new FootprintStore(GRID);
    const p = (k: number) => GRID.toPrice(GRID.toTick(5800) + k);
    store.setHistory([
      {
        t: T0,
        row: TICK,
        cells: [
          [p(0), 9, 0],
          [p(1), 20, 25],
          [p(2), 40, 90],
          [p(3), 30, 31],
          [p(4), 4, 6],
        ],
        deltaHigh: null,
        deltaLow: null,
      },
    ]);
    const v = store.view(store.at(0)!, 1);
    expect(v.poc).toBe(2);
    expect(v.deltaPoc).toBe(2);
    expect([v.vaLow, v.vaHigh]).toEqual([2, 3]);
    expect([v.unfinishedHigh, v.unfinishedLow]).toEqual([true, false]);
  });

  it('reads at the contract’s own row, draws volume as each bar’s profile, and tables each bar’s numbers', () => {
    expect([
      footprintRowTicks('NQ'),
      footprintRowTicks('MES'),
      footprintRowTicks('GC'),
      footprintRowTicks(null),
    ]).toEqual([4, 1, 3, 1]);
    const { bars, footprints } = market(40);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 60, lastBars: 20 });
    chart.render();
    const fine = fp.rowTicks;
    fp.setOptions({ minRowTicks: 4 });
    chart.render();
    expect(fp.rowTicks).toBeGreaterThanOrEqual(4);
    expect(fp.rowTicks % 4).toBe(0);
    expect(fine).toBeLessThan(4);
    fp.setOptions({ minRowTicks: 1, mode: 'volume', stats: true });
    expect(() => chart.render()).not.toThrow();
    chart.destroy();
  });

  it('tables the CVD the runtime counts, where it counts one, and reads footprints only from the first bar shown', () => {
    const { bars, footprints } = market(60);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h), options: { stats: true } });
    chart.addLayer(fp);
    fp.setStore(store);
    const cvd = cvdOf(bars, footprints, 50);
    fp.setCvd(cvd);
    chart.setViewport({ barSpacing: 60, lastBars: 20 });
    const ctx = chart.canvases.main.getContext('2d') as { fillText(t: string, x: number, y: number): void };
    const text = vi.spyOn(ctx, 'fillText');
    chart.render(true);
    const c = chart.coords();
    expect(fp.needFrom).toBe(bars[c.from]!.t);
    const xs = (i: number) =>
      text.mock.calls.filter((call) => Math.abs(call[1] - c.xOfIndex(i)) < 0.5).map((call) => call[0]);
    const close = cvd.column('close')!;
    expect(xs(55)).toContain(formatCount(close[55]!, true));
    expect(xs(48)).not.toContain(formatCount(close[48]!, true));
    expect(Number.isNaN(close[48]!)).toBe(true);
    chart.destroy();
  });

  it('runs a zone price has not traded back through up to the last bar, not on into the empty space after it', () => {
    const base = GRID.toTick(5800);
    const bars: Bar[] = [];
    const footprints: FootprintInput[] = [];
    for (let i = 0; i < 12; i++) {
      const t = T0 + i * MIN;
      const lo = i === 5 ? base : base + 10;
      const cells: [number, number, number][] = [];
      for (let r = 0; r < 10; r++) {
        const stacked = i === 5 && r >= 1 && r <= 3;
        const under = i === 5 && r <= 2;
        cells.push([GRID.toPrice(lo + r), under ? 5 : 20, stacked ? 60 : 20]);
      }
      const v = cells.reduce((n, c) => n + c[1] + c[2], 0);
      bars.push({
        t,
        o: GRID.toPrice(lo + 4),
        h: GRID.toPrice(lo + 9),
        l: GRID.toPrice(lo),
        c: GRID.toPrice(lo + 5),
        v,
      });
      footprints.push({ t, row: TICK, cells, deltaHigh: null, deltaLow: null });
    }
    const chart = chartWith(bars, { rightPadBars: 2 });
    chart.setLayerVisible('grid', false);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', options: { rowTicks: 1 }, createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 90 });
    chart.render(true);
    expect(fp.lod).toBeGreaterThanOrEqual(2);
    const c = chart.coords();
    const main = chart.canvases.main.getContext('2d') as ReturnType<ReturnType<typeof createCanvas>['getContext']>;
    const zoneY = Math.round(c.yOfPrice(GRID.toPrice(base + 2)));
    const ink = (x: number) => main.getImageData(Math.round(x), zoneY, 1, 1).data[3]!;
    const lastRight = c.xOfIndex(11) + c.barSpacing / 2;
    expect(ink(c.xOfIndex(8) + c.barSpacing / 2)).toBeGreaterThan(0);
    for (let x = lastRight + 2; x < c.plot.w - 2; x += 7) expect(ink(x)).toBe(0);
    chart.destroy();
  });

  it('tints a quiet bar lighter than a busy one of the same shape, on a scale the bars share', () => {
    const base = GRID.toTick(5800);
    const shape = [5, 10, 20, 40, 20, 10];
    const bars: Bar[] = [];
    const footprints: FootprintInput[] = [];
    for (let i = 0; i < 2; i++) {
      const t = T0 + i * MIN;
      const k = i === 0 ? 1 : 10;
      const cells = shape.map((v, r): [number, number, number] => [GRID.toPrice(base + r), (k * v) / 2, (k * v) / 2]);
      const v = cells.reduce((n, c) => n + c[1] + c[2], 0);
      const h = GRID.toPrice(base + 5);
      bars.push({ t, o: GRID.toPrice(base), h, l: GRID.toPrice(base), c: h, v });
      footprints.push({ t, row: TICK, cells, deltaHigh: null, deltaLow: null });
    }
    const chart = chartWith(bars, { rightPadBars: 2 });
    chart.setLayerVisible('grid', false);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', options: { rowTicks: 1 }, createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    const mid = GRID.toPrice(base + 3);
    chart.setViewport({ barSpacing: 30, price: { min: mid - 3, max: mid + 3 } });
    chart.render(true);
    expect(fp.lod).toBe(1);
    const c = chart.coords();
    const main = chart.canvases.main.getContext('2d') as ReturnType<ReturnType<typeof createCanvas>['getContext']>;
    const y = Math.round(c.yOfPrice(mid));
    const light = (i: number) => {
      const [r, g, b] = main.getImageData(Math.round(c.xOfIndex(i) + 3), y, 1, 1).data;
      return r! + g! + b!;
    };
    expect(light(0)).toBeLessThan(light(1));
    chart.destroy();
  });

  it('finds the same imbalance zones at every zoom, on the footprint rows rather than the merged rows shown', () => {
    const base = GRID.toTick(5800);
    const bars: Bar[] = [];
    const footprints: FootprintInput[] = [];
    for (let i = 0; i < 12; i++) {
      const t = T0 + i * MIN;
      const lo = i === 5 ? base : base + 20;
      const cells: [number, number, number][] = [];
      for (let r = 0; r < 12; r++) {
        const stacked = i === 5 && r >= 5 && r <= 7;
        const under = i === 5 && r >= 4 && r <= 6;
        cells.push([GRID.toPrice(lo + r), under ? 5 : 20, stacked ? 60 : 20]);
      }
      const v = cells.reduce((n, c) => n + c[1] + c[2], 0);
      bars.push({
        t,
        o: GRID.toPrice(lo + 4),
        h: GRID.toPrice(lo + 11),
        l: GRID.toPrice(lo),
        c: GRID.toPrice(lo + 5),
        v,
      });
      footprints.push({ t, row: TICK, cells, deltaHigh: null, deltaLow: null });
    }
    const chart = chartWith(bars, { rightPadBars: 2 });
    chart.setLayerVisible('grid', false);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    const main = chart.canvases.main.getContext('2d') as ReturnType<ReturnType<typeof createCanvas>['getContext']>;
    const zoneInk = (ticksShown: number) => {
      const mid = GRID.toPrice(base + 6);
      chart.setViewport({
        barSpacing: 90,
        price: { min: mid - (ticksShown / 2) * TICK, max: mid + (ticksShown / 2) * TICK },
      });
      chart.render(true);
      expect(fp.lod).toBeGreaterThanOrEqual(2);
      const c = chart.coords();
      const y = Math.round(c.yOfPrice(GRID.toPrice(base + 6)));
      return {
        rows: fp.rowTicks,
        ink: main.getImageData(Math.round(c.xOfIndex(8) + c.barSpacing / 2), y, 1, 1).data[3]!,
      };
    };
    const near = zoneInk(10);
    const far = zoneInk(150);
    expect(near.rows).toBe(1);
    expect(far.rows).toBe(4);
    expect(near.ink).toBeGreaterThan(0);
    expect(far.ink).toBeGreaterThan(0);
    chart.destroy();
  });

  it('names the bar under the pointer for the analyst', () => {
    const { bars, footprints } = market(40);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp' });
    fp.setStore(store);
    chart.addLayer(fp);
    chart.setViewport({ barSpacing: 30 });
    chart.render();
    const c = chart.coords();
    const i = bars.length - 3;
    const x = c.xOfIndex(i);
    const y = c.yOfPrice((bars[i]!.h + bars[i]!.l) / 2);
    const t = fp.askTarget(x, y)!;
    expect(t.kind).toBe('bar');
    expect(t.from).toBe(bars[i]!.t);
    expect(t.low).toBe(bars[i]!.l);
    expect(fp.askTarget(x, c.yOfPrice(bars[i]!.h + 20))).toBeNull();
    chart.destroy();
  });
});

interface DrawnCells {
  texts: { n: number; text: string[]; color: number[]; weight: number[] };
  peaks: { s: number[] };
  splits: ({ r: number[] } | undefined)[];
  tints: ({ r: number[] } | undefined)[];
}

const QUIET_INK = 3;
const DAY = 24 * 60 * MIN;

function drawnCells(
  options: Partial<FootprintOptions>,
  { n = 30, barSpacing = 120, timeframeMs = MIN, footprints = market(n).footprints } = {},
) {
  const { bars } = market(n);
  const spaced = bars.map((b, i) => ({ ...b, t: T0 + i * timeframeMs }));
  const inputs = footprints.map((f, i) => ({ ...f, t: T0 + i * timeframeMs }));
  const chart = chartWith(spaced, { timeframeMs, height: 2400 });
  const store = new FootprintStore(GRID);
  store.setHistory(inputs);
  const fp = new FootprintLayer({
    id: 'fp',
    createCanvas: (w, h) => createCanvas(w, h),
    options: { rowTicks: 1, ...options },
  });
  fp.setStore(store);
  chart.addLayer(fp);
  chart.setViewport({ barSpacing });
  chart.render(true);
  const drawn = (fp as unknown as { bufs: DrawnCells }).bufs;
  const { time } = (fp as unknown as { lastRc: { time: { from: number; to: number } } }).lastRc;
  const shown = {
    lod: fp.lod,
    bars: time.to - time.from + 1,
    texts: drawn.texts.text.slice(0, drawn.texts.n),
    colors: drawn.texts.color.slice(0, drawn.texts.n),
    weights: drawn.texts.weight.slice(0, drawn.texts.n),
    peaks: drawn.peaks.s.length / 4,
    splitRects: drawn.splits.reduce((k, p) => k + (p ? p.r.length / 4 : 0), 0),
    tintRects: drawn.tints.reduce((k, p) => k + (p ? p.r.length / 4 : 0), 0),
  };
  chart.destroy();
  return shown;
}

describe('footprint modes', () => {
  it('keeps each row’s trade count beside its volume, summed into merged rows and never lowered by a live update', () => {
    const store = new FootprintStore(GRID);
    const p = (k: number) => GRID.toPrice(GRID.toTick(5800) + k);
    store.setHistory(
      [
        {
          t: T0,
          row: TICK,
          cells: [
            [p(0), 9, 0, 4],
            [p(1), 20, 25, 30],
            [p(2), 40, 90, 12],
            [p(3), 60, 31, 9],
          ],
          deltaHigh: null,
          deltaLow: null,
        },
      ],
      true,
    );
    const bar = store.at(0)!;
    const v = store.view(bar, 1);
    expect([v.poc, v.tradesPoc, v.bidPeak, v.askPeak]).toEqual([2, 1, 3, 2]);
    expect(v.maxTrades).toBe(30);
    const merged = store.view(bar, 2);
    expect(Array.from(merged.trades)).toEqual([34, 21]);
    expect(merged.tradesPoc).toBe(0);
    store.apply({
      bar: { t: T0, row: TICK, cells: [[p(1), 21, 25, 31]], deltaHigh: null, deltaLow: null },
      closed: false,
      partial: true,
    });
    expect(Array.from(store.view(bar, 1).trades)).toEqual([4, 31, 12, 9]);
  });

  it('writes each row’s trade count in Trades', () => {
    const { footprints } = market(30);
    const shown = drawnCells({ mode: 'trades' });
    expect(shown.lod).toBeGreaterThanOrEqual(2);
    const counts = new Set(footprints.flatMap((f) => f.cells.map((c) => formatCount(c[3]!))));
    expect(shown.texts.length).toBeGreaterThan(5 * shown.bars);
    for (const text of shown.texts) expect(counts.has(text), text).toBe(true);
    expect(shown.texts).not.toEqual(drawnCells({ mode: 'volume' }).texts);
  });

  it('draws Bid × Ask histogram bars out from each bar’s centre, with the bid × ask figures over them and no tint', () => {
    const histogram = drawnCells({ mode: 'histogram' });
    const plain = drawnCells({ mode: 'bid_ask' });
    expect(histogram.lod).toBeGreaterThanOrEqual(2);
    expect(plain.splitRects, 'figures alone carry no bars').toBe(0);
    expect(histogram.splitRects).toBeGreaterThan(10 * histogram.bars);
    expect(histogram.tintRects).toBe(0);
    expect(histogram.texts).toEqual(plain.texts.filter((t) => t !== '×'));
    const mid = drawnCells({ mode: 'histogram' }, { barSpacing: 18 });
    expect(mid.lod).toBe(1);
    expect(mid.splitRects).toBeGreaterThan(10 * mid.bars);
  });

  it('fades every row that traded less than the set share of its bar’s busiest row, and only those', () => {
    const { footprints } = market(30);
    const base = drawnCells({ mode: 'volume' });
    const dimmed = drawnCells({ mode: 'volume', dimBelow: 50 });
    expect(dimmed.texts).toEqual(base.texts);
    const quiet = (s: typeof base) => s.colors.filter((c) => c === QUIET_INK).length;
    expect(quiet(base)).toBe(0);
    const under = (f: FootprintInput) => {
      const max = Math.max(...f.cells.map((c) => c[1] + c[2]));
      return f.cells.filter((c) => c[1] + c[2] > 0 && c[1] + c[2] < max / 2).length;
    };
    expect(quiet(dimmed)).toBeGreaterThan(0);
    expect(quiet(dimmed)).toBeLessThanOrEqual(footprints.reduce((k, f) => k + under(f), 0));
    const bidAsk = drawnCells({ mode: 'bid_ask', dimBelow: 90, ratio: 1.5, minVolume: 1 });
    bidAsk.colors.forEach((c, k) => {
      if (c === QUIET_INK) expect(bidAsk.weights[k]).toBe(0);
    });
    expect(drawnCells({ mode: 'delta', dimBelow: 50 }).tintRects).toBeLessThan(drawnCells({ mode: 'delta' }).tintRects);
  });

  it('outlines one row per bar with the most of the chosen measure, and nothing when Off or when no counts came', () => {
    const levels: FootprintMaxLevel[] = ['volume', 'trades', 'bid', 'ask'];
    for (const maxLevel of levels) {
      const shown = drawnCells({ maxLevel });
      expect(shown.bars).toBeGreaterThan(3);
      expect(shown.peaks, maxLevel).toBe(shown.bars);
    }
    expect(drawnCells({ maxLevel: 'off' }).peaks).toBe(0);
    const uncounted = market(30).footprints.map((f) => ({ ...f, cells: f.cells.map((c) => [c[0], c[1], c[2]]) }));
    expect(drawnCells({ maxLevel: 'trades' }, { footprints: uncounted }).peaks).toBe(0);
    expect(drawnCells({ mode: 'trades' }, { footprints: uncounted }).texts).toEqual([]);
  });

  it('draws every mode on minute, five-minute and daily bars', () => {
    const modes: FootprintMode[] = ['bid_ask', 'delta', 'volume', 'trades', 'histogram'];
    for (const timeframeMs of [MIN, 5 * MIN, DAY])
      for (const mode of modes) {
        const shown = drawnCells({ mode, maxLevel: 'volume', dimBelow: 20 }, { timeframeMs });
        expect(shown.texts.length, `${mode} at ${String(timeframeMs)}`).toBeGreaterThan(5 * shown.bars);
        expect(shown.peaks, `${mode} at ${String(timeframeMs)}`).toBe(shown.bars);
      }
  });
});

const DELTA_STYLE: DeltaStyle = {
  zero: style('#4a555b', { line: 'dot' }),
  delta: style('#5fc79c', { downColor: '#ec7b78', opacity: 0.5 }),
  cvd: style('#dcebef', { width: 1.25, opacity: 0.55 }),
};

describe('missing prints', () => {
  const FLOW_WORDS = /tick history|no prints|gap/i;
  const words = (values: { text: string }[]) => values.map((v) => v.text).filter((w) => FLOW_WORDS.test(w));
  const profileStyle = {
    poc: style('#dcebef'),
    vah: style('#6f7c82', { line: 'dot' as const }),
    val: style('#6f7c82', { line: 'dot' as const }),
  };
  type Engine = { layout(): { timeAxis: { x: number; y: number; w: number; h: number } } };

  function drawn(layers: (FootprintLayer | BigTradesLayer | VolumeProfileLayer | DeltaLayer)[], bars: Bar[]) {
    const chart = chartWith(bars);
    for (const l of layers) chart.addLayer(l);
    chart.setViewport({ barSpacing: 24, lastBars: 20 });
    chart.render(true);
    return chart;
  }

  function axisMark(chart: ReturnType<typeof chartWith>) {
    const axis = (chart.engine as unknown as Engine).layout().timeAxis;
    const ctx = chart.canvases.main.getContext('2d') as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    return (i: number) => {
      const x = Math.round(chart.coords().xOfIndex(i));
      return [...ctx.getImageData(x, Math.round(axis.y + 2), 1, 1).data];
    };
  }

  const CLEAR = [0, 0, 0, 0];
  const MUTED = [1, 3, 5].map((k) => parseInt(TESSERA_THEME.mutedText.slice(k, k + 2), 16));
  const muted = (px: number[]) => px.slice(0, 3).every((c, k) => Math.abs(c - MUTED[k]!) <= 2);

  it('never put words about missing ticks in a study’s legend, however much of the view is missing', () => {
    const { bars, footprints } = market(40);
    const everything = [{ from: T0 - MIN, to: bars[39]!.t + MIN }];
    const fp = new FootprintLayer({ id: 'fp' });
    const big = new BigTradesLayer({ id: 'bt', options: { legend: 'Above 50' } });
    const vp = new VolumeProfileLayer({ id: 'vp', grid: GRID, style: profileStyle });
    const cvd = new DeltaLayer({ id: 'cvd', style: DELTA_STYLE });
    const chart = drawn([fp, big, vp, cvd], bars);
    for (const l of [fp, big, vp]) l.setGaps(everything);
    const values = cvdOf(bars, footprints);
    values.column('close')!.fill(Number.NaN, 10, 39);
    cvd.setValues(values);
    chart.render(true);
    for (const l of [fp, big, vp, cvd]) expect(words(l.legendValues(30, FMT, TESSERA_THEME))).toEqual([]);
    expect(big.legendValues(30, FMT, TESSERA_THEME)).toEqual([{ text: 'Above 50', color: TESSERA_THEME.subtleText }]);
    chart.destroy();
  });

  it('mark the bars in a gap once, faintly, on the time axis, and nothing else', () => {
    const { bars } = market(40);
    const gap = [{ from: bars[28]!.t + 1, to: bars[30]!.t + 1 }];
    const marked = (layers: (FootprintLayer | BigTradesLayer | VolumeProfileLayer)[]) => {
      const chart = drawn(layers, bars);
      for (const l of layers) l.setGaps(gap);
      chart.render(true);
      const at = axisMark(chart);
      const out = { gap: [at(28), at(29), at(30)], clear: [at(26), at(27), at(31), at(35)] };
      chart.destroy();
      return out;
    };
    const one = marked([new FootprintLayer({ id: 'fp' })]);
    for (const px of one.clear) expect(px).toEqual(CLEAR);
    for (const px of one.gap) {
      expect(muted(px)).toBe(true);
      expect(px[3]).toBeGreaterThan(0);
      expect(px[3]).toBeLessThan(160);
    }
    const three = marked([
      new FootprintLayer({ id: 'fp' }),
      new BigTradesLayer({ id: 'bt' }),
      new VolumeProfileLayer({ id: 'vp', grid: GRID, style: profileStyle }),
    ]);
    expect(three).toEqual(one);
  });

  it('say which span a pointer over the strip is on, and nothing once it leaves it', () => {
    const { bars } = market(40);
    const fp = new FootprintLayer({ id: 'fp' });
    const chart = drawn([fp], bars);
    fp.setGaps([{ from: bars[29]!.t, to: bars[31]!.t }]);
    chart.render(true);
    const axis = (chart.engine as unknown as Engine).layout().timeAxis;
    const seen: unknown[] = [];
    chart.on('gap', (g) => seen.push(g && { from: g.from, to: g.to }));
    const y = axis.y + axis.h / 2;
    chart.engine.pointerMove(chart.coords().xOfIndex(30), y);
    chart.engine.pointerMove(chart.coords().xOfIndex(29), y);
    chart.engine.pointerMove(chart.coords().xOfIndex(35), y);
    chart.engine.pointerMove(chart.coords().xOfIndex(30), axis.y - 40);
    expect(seen).toEqual([{ from: bars[29]!.t, to: bars[30]!.t + MIN }, null]);
    chart.destroy();
  });

  it('take the mark away once the gap is filled, for a study drawn under the bars too', () => {
    const { bars } = market(40);
    const vp = new VolumeProfileLayer({ id: 'vp', grid: GRID, style: profileStyle });
    const chart = drawn([vp], bars);
    vp.setGaps([{ from: bars[29]!.t, to: bars[30]!.t }]);
    chart.render();
    expect(muted(axisMark(chart)(29))).toBe(true);
    vp.setGaps([]);
    chart.render();
    expect(axisMark(chart)(29)).toEqual(CLEAR);
    vp.setGaps([{ from: bars[29]!.t, to: bars[30]!.t }]);
    chart.render();
    chart.setLayerVisible('vp', false);
    chart.render();
    expect(axisMark(chart)(29)).toEqual(CLEAR);
    chart.destroy();
  });

  it('mark a bar a gap overlaps in any part, never one it only borders', () => {
    const { bars } = market(40);
    const store = { time: Float64Array.from(bars, (b) => b.t), length: bars.length };
    const view = { from: 20, to: 39, store, timeframeMs: MIN };
    expect(barsMissingPrints(view, [{ from: bars[30]!.t + 1, to: bars[30]!.t + 2 }])).toEqual([{ from: 30, to: 30 }]);
    expect(barsMissingPrints(view, [{ from: bars[30]!.t + MIN, to: bars[31]!.t + MIN }])).toEqual([
      { from: 31, to: 31 },
    ]);
    expect(barsMissingPrints(view, [{ from: bars[39]!.t + MIN, to: bars[39]!.t + 2 * MIN }])).toEqual([]);
    expect(
      barsMissingPrints(view, [
        { from: bars[24]!.t, to: bars[26]!.t },
        { from: bars[25]!.t, to: bars[27]!.t },
        { from: bars[10]!.t, to: bars[21]!.t },
      ]),
    ).toEqual([
      { from: 20, to: 20 },
      { from: 24, to: 26 },
    ]);
  });

  it('read a CVD’s missing prints from the bars with no value between bars with one', () => {
    const { bars, footprints } = market(50);
    const values = cvdOf(bars, footprints, 5);
    const close = values.column('close')!;
    close.fill(Number.NaN, 20, 23);
    close.fill(Number.NaN, 48, 50);
    const cvd = new DeltaLayer({ id: 'cvd', style: DELTA_STYLE });
    const chart = chartWith(bars, { volumePane: 0 });
    chart.addLayer(cvd);
    cvd.setValues(values);
    const store = { time: Float64Array.from(bars, (b) => b.t), length: bars.length };
    expect(cvd.missingPrints({ from: 0, to: 49, store, timeframeMs: MIN })).toEqual([
      { from: bars[20]!.t, to: bars[22]!.t + MIN },
    ]);
    expect(cvd.missingPrints({ from: 21, to: 30, store, timeframeMs: MIN })).toEqual([
      { from: bars[21]!.t, to: bars[22]!.t + MIN },
    ]);
    chart.destroy();
  });
});

describe('delta layer', () => {
  function deltaPane(bars: Bar[], values: SeriesValues) {
    const chart = chartWith(bars, { volumePane: 0 });
    const d = new DeltaLayer({ id: 'cvd', style: DELTA_STYLE });
    chart.addLayer(d);
    d.setValues(values);
    return { chart, d };
  }

  it('draws the runtime’s CVD as candles in the delta colours, up and down', () => {
    const { bars, footprints } = market(40);
    const values = cvdOf(bars, footprints);
    const { chart, d } = deltaPane(bars, values);
    chart.setViewport({ barSpacing: 24, lastBars: 20 });
    chart.render(true);
    const scale = (chart.engine as unknown as { paneScales: Map<string, { yOf(v: number): number }> }).paneScales.get(
      d.pane,
    )!;
    const [open, close] = [values.column('open')!, values.column('close')!];
    const body = (i: number) => {
      const ctx = chart.canvases.main.getContext('2d') as {
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
      const y = scale.yOf((open[i]! + close[i]!) / 2);
      return [...ctx.getImageData(Math.round(chart.coords().xOfIndex(i)), Math.round(y), 1, 1).data.slice(0, 3)];
    };
    const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const tall = (i: number) => Math.abs(scale.yOf(open[i]!) - scale.yOf(close[i]!)) > 6;
    const up = [...Array(40).keys()].find((i) => i >= 25 && close[i]! > open[i]! && tall(i))!;
    const down = [...Array(40).keys()].find((i) => i >= 25 && close[i]! < open[i]! && tall(i))!;
    expect(body(up)).toEqual(hex(chart.theme.flow.deltaUp));
    expect(body(down)).toEqual(hex(chart.theme.flow.deltaDown));
    chart.destroy();
  });

  it('names the CVD or the bar delta at a bar, the last known one at the right edge, and from when it is known', () => {
    const { bars, footprints } = market(50);
    const values = cvdOf(bars, footprints, 10);
    const { chart, d } = deltaPane(bars, values);
    const close = values.column('close')!;
    const delta = values.column('delta')!;
    values.replaceSpan(bars[49]!.t, bars[49]!.t, Float64Array.of(bars[49]!.t), {});
    d.valuesChanged({ kind: 'span', from: bars[49]!.t, to: bars[49]!.t });
    expect(d.legendName).toBe('CVD');
    expect(d.legendValues(30, FMT, TESSERA_THEME)[0]!.text).toBe(signedCount(close[30]!));
    expect(d.legendValues(49, FMT, TESSERA_THEME)[0]!.text).toBe(signedCount(close[48]!));
    expect(d.legendValues(5, FMT, TESSERA_THEME)).toEqual([]);
    d.setOptions({ mode: 'bar' });
    expect(d.legendName).toBe('Δ');
    expect(d.legendValues(30, FMT, TESSERA_THEME)[0]!.text).toBe(signedCount(delta[30]!));
    chart.destroy();
  });

  it('keeps the CVD on its bars when older bars are read back in front, and as new bars form', () => {
    const { bars, footprints } = market(61);
    const values = cvdOf(bars.slice(0, 60), footprints.slice(0, 60), 20);
    const { chart, d } = deltaPane(bars.slice(20, 60), values);
    const close = values.column('close')!.slice();
    const at = (t: number) => {
      const s = chart.getSeries('main')!;
      const i = s.indexOfTime(t);
      return d.legendValues(i, FMT, TESSERA_THEME)[0]?.text;
    };
    expect(at(bars[30]!.t)).toBe(signedCount(close[30]!));
    expect(chart.prepend('main', bars.slice(0, 20))).toBe(20);
    expect(at(bars[30]!.t)).toBe(signedCount(close[30]!));
    expect(at(bars[59]!.t)).toBe(signedCount(close[59]!));
    chart.update('main', bars[60]!);
    expect(at(bars[60]!.t)).toBe(signedCount(close[59]!));
    const next = close[59]! + 42;
    values.replaceSpan(bars[60]!.t, bars[60]!.t, Float64Array.of(bars[60]!.t), {
      close: Float64Array.of(next),
      open: Float64Array.of(close[59]!),
      high: Float64Array.of(next),
      low: Float64Array.of(close[59]!),
      delta: Float64Array.of(42),
      volume: Float64Array.of(50),
      candle: Float64Array.of(1),
    });
    d.valuesChanged({ kind: 'span', from: bars[60]!.t, to: bars[60]!.t });
    expect(at(bars[60]!.t)).toBe(signedCount(next));
    chart.destroy();
  });

  describe('extras', () => {
    function shown(o: Partial<DeltaOptions>, bars: Bar[], values: SeriesValues) {
      const { chart, d } = deltaPane(bars, values);
      d.setOptions(o);
      chart.setViewport({ barSpacing: 24, lastBars: 20 });
      chart.render(true);
      const scale = (chart.engine as unknown as { paneScales: Map<string, { yOf(v: number): number }> }).paneScales.get(
        d.pane,
      )!;
      const ctx = chart.canvases.main.getContext('2d') as {
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
      const x = (i: number) => Math.round(chart.coords().xOfIndex(i));
      const rgb = (px: number, py: number) => [...ctx.getImageData(px, Math.round(py), 1, 1).data.slice(0, 3)];
      const ink = (px: number, py: number) => ctx.getImageData(px, Math.round(py), 1, 1).data[3]!;
      return { chart, d, scale, x, rgb, ink };
    }
    const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));

    it('measures a bar’s delta as a share of its volume, and price closing against its delta', () => {
      expect(deltaShare(-30, 120)).toBe(25);
      expect(deltaShare(30, 0)).toBeNaN();
      expect(priceAgainstDelta(10, 11, -5)).toBe(1);
      expect(priceAgainstDelta(11, 10, 5)).toBe(-1);
      expect(priceAgainstDelta(10, 11, 5)).toBe(0);
      expect(priceAgainstDelta(10, 10, -5)).toBe(0);
      expect(priceAgainstDelta(10, 11, 0)).toBe(0);
    });

    it('draws the running total as bars from zero, and keeps zero on the scale', () => {
      const { bars, footprints } = market(40);
      const values = cvdOf(bars, footprints);
      const close = values.column('close')!;
      const { chart, d, scale, x, ink } = shown({ style: 'histogram' }, bars, values);
      const tall = [...Array(40).keys()].find((i) => i >= 25 && Math.abs(scale.yOf(close[i]!) - scale.yOf(0)) > 12)!;
      const mid = (scale.yOf(close[tall]!) + scale.yOf(0)) / 2;
      expect(ink(x(tall), mid)).toBeGreaterThan(20);
      const [lo, hi] = d.autoscaleRange(25, 39)!;
      expect(lo <= 0 && hi >= 0).toBe(true);
      expect(d.legendName).toBe('CVD');
      chart.destroy();
    });

    it('keeps the bars past the delta % at full strength and fades the rest', () => {
      const { bars, footprints } = market(40);
      const values = cvdOf(bars, footprints);
      const [delta, volume] = [values.column('delta')!, values.column('volume')!];
      const share = (i: number) => deltaShare(delta[i]!, volume[i]!);
      const view = [...Array(15).keys()].map((k) => k + 25);
      const cut = 15;
      const strong = view.find((i) => share(i) >= cut && Math.abs(delta[i]!) > 60)!;
      const weak = view.find((i) => share(i) < cut && Math.abs(delta[i]!) > 20)!;
      expect(strong).toBeDefined();
      expect(weak).toBeDefined();
      const tip = (scale: { yOf(v: number): number }, i: number) => (scale.yOf(0) + scale.yOf(delta[i]! * 0.5)) / 2;
      const plain = shown({ mode: 'bar' }, bars, values);
      const before = [
        plain.ink(plain.x(strong), tip(plain.scale, strong)),
        plain.ink(plain.x(weak), tip(plain.scale, weak)),
      ];
      plain.chart.destroy();
      const lit = shown({ mode: 'bar', highlight: cut }, bars, values);
      expect(lit.ink(lit.x(strong), tip(lit.scale, strong))).toBe(before[0]);
      expect(lit.ink(lit.x(weak), tip(lit.scale, weak))).toBeLessThan(before[1]! * 0.5);
      lit.chart.destroy();
    });

    it('fades the CVD candles under the delta % and dots the line where it passes', () => {
      const { bars, footprints } = market(40);
      const values = cvdOf(bars, footprints);
      const column = (k: string) => values.column(k)!;
      const [delta, volume, open, close] = [column('delta'), column('volume'), column('open'), column('close')];
      const view = [...Array(15).keys()].map((k) => k + 25);
      const cut = 15;
      const weak = view.find((i) => deltaShare(delta[i]!, volume[i]!) < cut && Math.abs(delta[i]!) > 40)!;
      const strong = view.find((i) => deltaShare(delta[i]!, volume[i]!) >= cut)!;
      const body = (s: { yOf(v: number): number }, i: number) => (s.yOf(open[i]!) + s.yOf(close[i]!)) / 2;
      const candles = shown({ highlight: cut }, bars, values);
      expect(candles.rgb(candles.x(strong), body(candles.scale, strong))).toEqual(
        hex(delta[strong]! > 0 ? candles.chart.theme.flow.deltaUp : candles.chart.theme.flow.deltaDown),
      );
      expect(candles.ink(candles.x(weak), body(candles.scale, weak))).toBeLessThan(
        candles.ink(candles.x(strong), body(candles.scale, strong)) * 0.5,
      );
      candles.chart.destroy();
      const line = shown({ style: 'line', highlight: cut }, bars, values);
      expect(line.rgb(line.x(strong), line.scale.yOf(close[strong]!))).toEqual(
        hex(delta[strong]! > 0 ? line.chart.theme.flow.deltaUp : line.chart.theme.flow.deltaDown),
      );
      line.chart.destroy();
    });

    it('marks a bar whose price closed against its delta past its mark, pointing the way price went', () => {
      const { bars, footprints } = market(40);
      const values = cvdOf(bars, footprints);
      const delta = values.column('delta')!;
      const view = [...Array(15).keys()].map((k) => k + 25);
      const against = (i: number) => priceAgainstDelta(bars[i]!.o, bars[i]!.c, delta[i]!);
      const marked = view.filter((i) => against(i) !== 0);
      const plainBar = view.find((i) => against(i) === 0 && delta[i] !== 0)!;
      expect(marked.length).toBeGreaterThan(1);
      const where = (s: { yOf(v: number): number }, i: number) =>
        delta[i]! > 0 ? s.yOf(Math.max(0, delta[i]!)) - 5.5 : s.yOf(Math.min(0, delta[i]!)) + 5.5;
      const on = shown({ mode: 'bar', divergence: true }, bars, values);
      for (const i of marked)
        expect(on.rgb(on.x(i), where(on.scale, i))).toEqual(
          hex(against(i) > 0 ? on.chart.theme.upFill : on.chart.theme.downFill),
        );
      expect(on.ink(on.x(plainBar), where(on.scale, plainBar))).toBe(0);
      on.chart.destroy();
      const off = shown({ mode: 'bar' }, bars, values);
      for (const i of marked) expect(off.ink(off.x(i), where(off.scale, i))).toBe(0);
      off.chart.destroy();
    });
  });
});

describe('footprint store', () => {
  it('keeps every older page read back past five sessions of minutes', () => {
    const { footprints } = market(9000);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints.slice(8800), true);
    for (let to = 8800; to > 0; to -= 200) store.addOlder(footprints.slice(to - 200, to));
    expect(store.length).toBe(9000);
    expect(store.firstTime).toBe(footprints[0]!.t);
  });

  it('takes older bars only while there is room, never letting newer ones go', () => {
    const { footprints } = market(30);
    const store = new FootprintStore(GRID, 20);
    store.setHistory(footprints.slice(15));
    expect(store.addOlder(footprints.slice(5, 15))).toBe(5);
    expect(store.firstTime).toBe(footprints[10]!.t);
    expect(store.get(footprints[29]!.t)).toBeDefined();
    expect(store.addOlder(footprints.slice(0, 10))).toBe(0);
    expect(store.length).toBe(20);
    store.apply({ bar: { ...footprints[29]!, t: footprints[29]!.t + MIN }, closed: false, partial: false });
    expect(store.length).toBe(20);
    expect(store.firstTime).toBe(footprints[11]!.t);
  });
});

describe('delta pane scale', () => {
  it('fits a running total far from zero to itself, keeps zero for bar delta, and keeps clear of the bar stats', () => {
    const { bars, footprints } = market(60);
    const selling = footprints.map((f) => ({
      ...f,
      cells: f.cells.map((c): [number, number, number] => [c[0], c[1] + 200, c[2]]),
      deltaHigh: null,
      deltaLow: null,
    }));
    const chart = chartWith(bars);
    const d = new DeltaLayer({ id: 'cvd', style: DELTA_STYLE });
    chart.addLayer(d);
    d.setValues(cvdOf(bars, selling));
    chart.render();
    const [lo, hi] = d.autoscaleRange(50, 59)!;
    expect(hi).toBeLessThan(0);
    expect(lo).toBeLessThan(hi);
    const early = d.autoscaleRange(0, 3)!;
    expect(early[0] <= 0 && early[1] >= 0).toBe(true);
    d.setOptions({ mode: 'bar' });
    expect(d.autoscaleRange(50, 59)![1]).toBeGreaterThanOrEqual(0);
    expect(d.autoscaleReserve(64, 200)).toBeGreaterThan(30);
    expect(d.autoscaleReserve(40, 200)).toBe(0);
    d.setOptions({ barStats: false });
    expect(d.autoscaleReserve(64, 200)).toBe(0);
    chart.destroy();
  });
});

describe('volume profile layer', () => {
  it('asks for the settled view as one span and draws it at the right edge', () => {
    const { bars } = market(100);
    const chart = chartWith(bars);
    const rows = 40;
    const lo = Math.min(...bars.map((b) => b.l));
    const volume = new Float64Array(rows).map((_, k) => 100 + (k === 7 ? 900 : k));
    const asked: [number, number | null, string][] = [];
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'visible', rowTicks: 1 },
      style: { poc: style('#dcebef'), vah: style('#6f7c82', { line: 'dot' }), val: style('#6f7c82', { line: 'dot' }) },
    });
    vp.setSource({
      periods: () => [],
      composite: () => null,
      span: (from, to, hours) => {
        asked.push([from, to, hours]);
        return {
          from,
          to: to ?? bars[99]!.t + MIN,
          label: '',
          rowTicks: 1,
          lowTick: GRID.toTick(lo),
          rows,
          volume,
          buy: volume.map((v) => v / 2),
          sell: volume.map((v) => v / 2),
        };
      },
    });
    chart.addLayer(vp);
    chart.setViewport({ barSpacing: 12 });
    chart.render();
    const view = chart.getViewport();
    expect(asked.at(-1)).toEqual([bars[view.from]!.t, null, 'all']);
    expect(vp.rendered().map((p) => p.label)).toEqual(['Visible']);
    expect(vp.legendValues(0, FMT, TESSERA_THEME)[0]!.text).toBe(
      `POC ${FMT.grouped(GRID.toPrice(GRID.toTick(lo) + 7))}`,
    );
    chart.destroy();
  });

  it('draws each session from its first bar and uses the runtime levels at a 70% value area', () => {
    const { bars } = market(90);
    const chart = chartWith(bars);
    const rows = 40;
    const volume = new Float64Array(rows).map((_, k) => 100 + (k === 12 ? 900 : k));
    const session: SessionProfileData = {
      from: bars[0]!.t,
      to: bars[89]!.t + MIN,
      label: 'Mon',
      rowTicks: 1,
      lowTick: GRID.toTick(5790),
      rows,
      volume,
      buy: volume.map((v) => v / 2),
      sell: volume.map((v) => v / 2),
      levels: { poc: 5793, vah: 5797, val: 5791 },
    };
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      style: { poc: style('#dcebef'), vah: style('#6f7c82', { line: 'dot' }), val: style('#6f7c82', { line: 'dot' }) },
    });
    vp.setSource({ periods: () => [session], composite: () => null, span: () => null });
    chart.addLayer(vp);
    chart.render();
    expect(vp.legendValues(0, FMT, TESSERA_THEME)[0]!.text).toBe('POC 5,793.00');
    vp.setOptions({ valueArea: 0.8 });
    chart.render();
    expect(vp.legendValues(0, FMT, TESSERA_THEME)[0]!.text).toBe(`POC ${FMT.grouped(5793)}`);
    chart.destroy();
  });

  it('draws the session beside footprint bars, never under their cells or the legend, and over candles as before', () => {
    const { bars, footprints } = market(60);
    const lowTick = Math.min(...bars.map((b) => GRID.toTick(b.l)));
    const rows = Math.max(...bars.map((b) => GRID.toTick(b.h))) - lowTick + 1;
    const volume = new Float64Array(rows).map((_, k) => 50 + ((k * 37) % 400));
    const session: SessionProfileData = {
      from: bars[0]!.t,
      to: bars[59]!.t + MIN,
      label: 'Mon',
      rowTicks: 1,
      lowTick,
      rows,
      volume,
      buy: volume.map((v) => v / 2),
      sell: volume.map((v) => v / 2),
    };
    const drawAt = (barSpacing: number, pan = 0) => {
      const chart = chartWith(bars);
      chart.setLayerVisible('grid', false);
      const store = new FootprintStore(GRID);
      store.setHistory(footprints);
      const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
      fp.setStore(store);
      chart.addLayer(fp);
      const vp = new VolumeProfileLayer({
        id: 'vp',
        grid: GRID,
        options: { rowTicks: 1, nakedPocs: false },
        style: {
          poc: style('#dcebef'),
          vah: style('#6f7c82', { line: 'dot' }),
          val: style('#6f7c82', { line: 'dot' }),
        },
      });
      vp.setSource({ periods: () => [session], composite: () => null, span: () => null });
      chart.addLayer(vp);
      chart.setViewport({ barSpacing });
      chart.render(true);
      if (pan) {
        chart.setViewport({ rightEdgeSlot: chart.getViewport().rightEdgeSlot + pan });
        chart.render(true);
      }
      const plot = chart.coords().plot;
      const read = (s: 'underlay' | 'main' | 'overlay') =>
        (chart.canvases[s].getContext('2d') as ReturnType<ReturnType<typeof createCanvas>['getContext']>).getImageData(
          0,
          0,
          plot.w,
          plot.h,
        ).data;
      const [under, main] = [read('underlay'), read('main')];
      const legend = chart.getLayer('legend', LegendLayer)!.extent!;
      const inLegend = (x: number, y: number) =>
        x >= legend.x && x < legend.x + legend.w && y >= legend.y && y < legend.y + legend.h;
      const at = (d: Uint8ClampedArray, x: number, y: number) => d[(y * plot.w + x) * 4 + 3]!;
      let histogram = 0;
      let underCells = 0;
      let underLegend = 0;
      const profileRows = new Map<number, number>();
      let inkLeft = plot.w;
      for (let y = 0; y < plot.h; y += 2)
        for (let x = 0; x < plot.w; x += 2) {
          if (at(main, x, y) > 0 && y > legend.y + legend.h) inkLeft = Math.min(inkLeft, x);
          const a = at(under, x, y);
          if (a === 0 || a > 200) continue;
          histogram++;
          profileRows.set(x, (profileRows.get(x) ?? 0) + 1);
          if (at(main, x, y) > 0) underCells++;
          if (inLegend(x, y)) underLegend++;
        }
      const histogramRight = Math.max(0, ...[...profileRows].filter(([, rows]) => rows > 10).map(([x]) => x));
      const c = chart.coords();
      const firstCentre = c.xOfIndex(c.from);
      chart.destroy();
      return {
        lod: fp.lod,
        histogram,
        underCells,
        underLegend,
        histogramRight,
        inkLeft,
        firstCentre,
        spacing: c.barSpacing,
      };
    };
    const footprint = drawAt(90);
    expect(footprint.lod).toBeGreaterThanOrEqual(2);
    expect(footprint.histogram).toBeGreaterThan(0);
    expect(footprint.underCells).toBe(0);
    expect(footprint.underLegend).toBe(0);
    for (const pan of [0, 0.2, 0.4, 0.6, 0.8]) {
      const panned = drawAt(90, pan);
      expect(panned.underCells).toBe(0);
      expect(panned.inkLeft - panned.histogramRight).toBeLessThanOrEqual(panned.spacing / 2 + 8);
      expect(panned.firstCentre).toBeGreaterThanOrEqual(panned.inkLeft - 2);
    }
    const candles = drawAt(6);
    expect(candles.lod).toBe(0);
    expect(candles.histogram).toBeGreaterThan(0);
    expect(candles.underCells).toBeGreaterThan(0);
  });
});

describe('a footprint zoomed out past candle bodies', () => {
  it('leaves the bars to the candles and reads no footprint history', () => {
    const { bars, footprints } = market(3_000);
    const chart = chartWith(bars, { width: 900, height: 500 });
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp', createCanvas: (w, h) => createCanvas(w, h) });
    fp.setStore(store);
    chart.addLayer(fp);
    const pixels = () => {
      chart.render(true);
      const ctx = chart.canvases.main.getContext('2d') as CanvasRenderingContext2D;
      return ctx.getImageData(0, 0, 900, 500).data;
    };
    chart.setViewport({ fitAll: true });
    const withFootprint = pixels();
    expect(chart.getViewport().barSpacing).toBeLessThan(CANDLE_BODY_MIN_SPACING);
    expect(fp.needFrom).toBeNull();
    chart.setLayerVisible('fp', false);
    expect(Buffer.compare(Buffer.from(pixels()), Buffer.from(withFootprint))).toBe(0);
    chart.setLayerVisible('fp', true);
    chart.setViewport({ barSpacing: 6 });
    pixels();
    const vp = chart.getViewport();
    expect(fp.needFrom).toBe(bars[vp.from]!.t);
    chart.destroy();
  });
});

describe('volume profile tags', () => {
  it('read the RTH profile, not the whole session, when the profile shows RTH only', () => {
    const { bars } = market(90);
    const chart = chartWith(bars);
    const rows = 40;
    const lo = Math.min(...bars.map((b) => b.l));
    const session = (from: number, peak: number): SessionProfileData => {
      const volume = new Float64Array(rows).map((_, k) => 100 + (k === peak ? 900 : k));
      return {
        from,
        to: bars[89]!.t + MIN,
        label: 'Mon',
        rowTicks: 1,
        lowTick: GRID.toTick(lo),
        rows,
        volume,
        buy: volume.map((v) => v / 2),
        sell: volume.map((v) => v / 2),
      };
    };
    const all = session(bars[0]!.t, 12);
    const rth = session(bars[30]!.t, 30);
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { rowTicks: 1, nakedPocs: false },
      style: { poc: style('#dcebef'), vah: style('#6f7c82', { line: 'dot' }), val: style('#6f7c82', { line: 'dot' }) },
    });
    vp.setSource({
      periods: (_p, hours) => (hours === 'rth' ? [rth] : [all]),
      composite: () => null,
      span: () => null,
    });
    chart.addLayer(vp);
    chart.render();
    expect(vp.legendValues(0, FMT, TESSERA_THEME)[0]!.text).toBe(
      `POC ${FMT.grouped(GRID.toPrice(GRID.toTick(lo) + 12))}`,
    );
    vp.setOptions({ hours: 'rth' });
    chart.render();
    expect(vp.legendValues(0, FMT, TESSERA_THEME)[0]!.text).toBe(
      `POC ${FMT.grouped(GRID.toPrice(GRID.toTick(lo) + 30))}`,
    );
    vp.setOptions({ hours: 'split' });
    chart.render();
    expect(vp.legendValues(0, FMT, TESSERA_THEME)[0]!.text).toBe(
      `POC ${FMT.grouped(GRID.toPrice(GRID.toTick(lo) + 12))}`,
    );
    const asked: (string | undefined)[] = [];
    vp.setSource({
      periods: (_p, hours) => (hours === 'rth' ? [rth] : [all]),
      composite: (_n, _period, hours) => {
        asked.push(hours);
        return hours === 'rth' ? rth : all;
      },
      span: () => null,
    });
    vp.setOptions({ period: 'composite', hours: 'rth' });
    chart.render();
    expect(asked.at(-1), 'a composite is asked for the profile’s own hours').toBe('rth');
    expect(vp.rendered()[0]!.volume).toBe(rth.volume.reduce((a, b) => a + b, 0));
    vp.setOptions({ hours: 'all' });
    chart.render();
    expect(asked.at(-1)).toBe('all');
    expect(vp.rendered()[0]!.volume).toBe(all.volume.reduce((a, b) => a + b, 0));
    chart.destroy();
  });

  it('tags the session trading now on bars that opened after it was read, up to its scheduled end', () => {
    const { bars } = market(90);
    const chart = chartWith(bars);
    const rows = 40;
    const volume = new Float64Array(rows).map((_, k) => 100 + (k === 12 ? 900 : k));
    const lo = Math.min(...bars.map((b) => b.l));
    const session = (to: number): SessionProfileData => ({
      from: bars[0]!.t,
      to,
      label: 'Mon',
      rowTicks: 1,
      lowTick: GRID.toTick(lo),
      rows,
      volume,
      buy: volume.map((v) => v / 2),
      sell: volume.map((v) => v / 2),
    });
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      style: { poc: style('#dcebef'), vah: style('#6f7c82', { line: 'dot' }), val: style('#6f7c82', { line: 'dot' }) },
    });
    let held = session(bars[89]!.t + 60 * MIN);
    vp.setSource({ periods: () => [held], composite: () => null, span: () => null });
    chart.addLayer(vp);
    chart.render();
    const rc = (vp as unknown as { lastRc: Parameters<VolumeProfileLayer['labelClaims']>[0] }).lastRc;
    expect(vp.labelClaims(rc).length).toBeGreaterThan(0);
    held = session(bars[60]!.t);
    vp.dataChanged();
    chart.render();
    expect(vp.labelClaims(rc)).toHaveLength(0);
    chart.destroy();
  });
});

describe('volume profile periods', () => {
  const PROFILE_STYLE = {
    poc: style('#dcebef'),
    vah: style('#6f7c82', { line: 'dot' as const }),
    val: style('#6f7c82', { line: 'dot' as const }),
  };
  const periodOver = (bars: Bar[], from: number, to: number, label: string, peak: number): SessionProfileData => {
    const rows = 40;
    const lo = Math.min(...bars.map((b) => b.l));
    const volume = new Float64Array(rows).map((_, k) => 100 + (k === peak ? 900 : k));
    return {
      from: bars[from]!.t,
      to: bars[to]!.t + MIN,
      label,
      rowTicks: 1,
      lowTick: GRID.toTick(lo),
      rows,
      volume,
      buy: volume.map((v) => v / 2),
      sell: volume.map((v) => v / 2),
    };
  };

  it('draws one profile per week and says which it drew, with its POC', () => {
    const { bars } = market(90);
    const chart = chartWith(bars);
    const weeks = [periodOver(bars, 0, 44, 'Wk Sep 21', 10), periodOver(bars, 45, 89, 'Wk Sep 28', 20)];
    const asked: string[] = [];
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'week', rowTicks: 1, nakedPocs: false },
      style: PROFILE_STYLE,
    });
    vp.setSource({ periods: () => weeks, composite: () => null, span: () => null });
    chart.addLayer(vp);
    chart.render();
    const drew = vp.rendered();
    expect(drew.map((p) => p.label)).toEqual(['Wk Sep 21', 'Wk Sep 28']);
    expect(drew[1]!.poc).toBe(GRID.toPrice(weeks[1]!.lowTick + 20));
    expect(drew[1]!.volume).toBeGreaterThan(0);
    expect(vp.legendSuffix()).toBe('');
    vp.setSource({
      periods: () => weeks,
      composite: (n, period) => {
        asked.push(`${String(n)} ${period}`);
        return periodOver(bars, 0, 89, '3 weeks', 5);
      },
      span: () => null,
    });
    vp.setOptions({ period: 'composite', compositePeriod: 'week', length: 3 });
    chart.render();
    expect(asked.at(-1)).toBe('3 week');
    expect(vp.legendSuffix()).toBe('3 weeks');
    expect(vp.rendered().map((p) => [p.label, p.poc])).toEqual([['3 weeks', GRID.toPrice(weeks[0]!.lowTick + 5)]]);
    chart.destroy();
  });

  it('draws a profile against its period end and carries the prior period’s POC and VA across the newest', () => {
    const { bars } = market(90);
    const chart = chartWith(bars);
    const weeks = [periodOver(bars, 0, 44, 'Wk Sep 21', 10), periodOver(bars, 45, 89, 'Wk Sep 28', 20)];
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'week', rowTicks: 1, nakedPocs: false },
      style: PROFILE_STYLE,
    });
    vp.setSource({ periods: () => weeks, composite: () => null, span: () => null });
    chart.addLayer(vp);
    chart.render();
    const spans = () =>
      (vp as unknown as { lastSessions: { x0: number; x1: number }[] }).lastSessions.map((s) => ({
        x0: s.x0,
        x1: s.x1,
      }));
    const left = spans();
    vp.setOptions({ side: 'right' });
    chart.render();
    const right = spans();
    expect(right[1]!.x1).toBeGreaterThan(left[1]!.x0);
    expect(right[1]!.x0).toBeGreaterThan(left[1]!.x0);
    const rc = (vp as unknown as { lastRc: Parameters<VolumeProfileLayer['labelClaims']>[0] }).lastRc;
    const claims = () => vp.labelClaims(rc).length;
    const before = claims();
    vp.setOptions({ priorVa: true });
    chart.render();
    expect(claims()).toBeGreaterThan(before);
    chart.destroy();
  });

  it('draws a period no wider than one bar across its whole bar, as sessions on a daily chart', () => {
    const { bars } = market(400);
    const chart = chartWith(bars);
    chart.setViewport({ barSpacing: 5 });
    const n = bars.length;
    const days = [1, 2, 3, 4, 5].map((k) => periodOver(bars, n - k, n - k, `Day ${String(k)}`, k));
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'session', length: 5, nakedPocs: false },
      style: PROFILE_STYLE,
    });
    vp.setSource({ periods: () => days, composite: () => null, span: () => null });
    chart.addLayer(vp);
    chart.render();
    const rc = (vp as unknown as { lastRc: Parameters<VolumeProfileLayer['labelClaims']>[0] }).lastRc;
    const spacing = rc.time.barSpacing;
    expect(spacing).toBeLessThan(6);
    expect(
      vp
        .rendered()
        .map((p) => p.label)
        .sort(),
    ).toEqual(['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5']);
    const widths = (vp as unknown as { lastSessions: { x0: number; x1: number }[] }).lastSessions.map(
      (s) => s.x1 - s.x0,
    );
    for (const w of widths) expect(w).toBeCloseTo(spacing, 5);
    chart.destroy();
  });
});

describe('volume profile on any bars', () => {
  const PROFILE_STYLE = {
    poc: style('#dcebef'),
    vah: style('#6f7c82', { line: 'dot' as const }),
    val: style('#6f7c82', { line: 'dot' as const }),
  };
  const DAY = 86_400_000;
  const profileOver = (from: number, to: number, label: string, lo: number): SessionProfileData => {
    const rows = 40;
    const volume = new Float64Array(rows).map((_, k) => 100 + (k === 9 ? 900 : k));
    return {
      from,
      to,
      label,
      rowTicks: 1,
      lowTick: GRID.toTick(lo),
      rows,
      volume,
      buy: volume.map((v) => v / 2),
      sell: volume.map((v) => v / 2),
    };
  };
  const source = (o: { periods?: SessionProfileData[]; span?: SessionProfileData }) => ({
    periods: () => o.periods ?? [],
    composite: () => null,
    span: (from: number, to: number | null) => (o.span ? { ...o.span, from, to: to ?? o.span.to } : null),
  });

  it('draws and reports an RTH profile on daily bars, inside the day’s bar', () => {
    const { bars: minutes } = market(30);
    const days = minutes.map((b, k) => ({ ...b, t: Date.UTC(2026, 8, 1) + k * DAY }));
    const chart = chartWith(days, { timeframeMs: DAY });
    chart.setViewport({ barSpacing: 20 });
    const lo = Math.min(...days.map((b) => b.l));
    const rth = [27, 28, 29].map((k) =>
      profileOver(days[k]!.t + 13.5 * 3_600_000, days[k]!.t + 20 * 3_600_000, `Day ${String(k)} RTH`, lo),
    );
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'session', hours: 'rth', length: 3, nakedPocs: false },
      style: PROFILE_STYLE,
    });
    vp.setSource(source({ periods: rth }));
    chart.addLayer(vp);
    chart.render();
    expect(vp.rendered().map((p) => p.label)).toEqual(['Day 27 RTH', 'Day 28 RTH', 'Day 29 RTH']);
    const placed = (vp as unknown as { lastSessions: { x0: number; x1: number }[] }).lastSessions;
    const c = chart.coords();
    expect(placed[2]!.x0).toBeCloseTo(c.xOfIndex(29) - c.barSpacing / 2, 5);
    chart.destroy();
  });

  it('draws session profiles on volume bars of uneven length, from the bar that holds each start', () => {
    const { bars } = market(60);
    let t = T0;
    const uneven = bars.map((b, k) => {
      t += (k % 3 === 0 ? 7 : 2) * MIN;
      return { ...b, t };
    });
    const chart = chartWith(uneven);
    const lo = Math.min(...uneven.map((b) => b.l));
    const sessions = [
      profileOver(uneven[0]!.t, uneven[29]!.t + MIN, 'Mon', lo),
      profileOver(uneven[30]!.t - MIN, uneven[59]!.t + MIN, 'Tue', lo),
    ];
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'session', nakedPocs: false },
      style: PROFILE_STYLE,
    });
    vp.setSource(source({ periods: sessions }));
    chart.addLayer(vp);
    chart.setViewport({ fitAll: true });
    chart.render();
    expect(vp.rendered().map((p) => p.label)).toEqual(['Mon', 'Tue']);
    const placed = (vp as unknown as { lastSessions: { x0: number }[] }).lastSessions;
    const c = chart.coords();
    expect(placed[1]!.x0).toBeCloseTo(c.xOfIndex(30) - c.barSpacing / 2, 5);
    chart.destroy();
  });

  it('draws a fixed range over its bars and an anchored one to the newest bar, as studies', () => {
    const { bars } = market(90);
    const chart = chartWith(bars);
    const lo = Math.min(...bars.map((b) => b.l));
    const held = profileOver(bars[20]!.t, bars[60]!.t + MIN, '', lo);
    const asked: (number | null)[] = [];
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'range', from: bars[20]!.t, to: bars[60]!.t + MIN, rowTicks: 1 },
      style: PROFILE_STYLE,
    });
    vp.setSource({
      ...source({ span: held }),
      span: (from, to) => {
        asked.push(to);
        return { ...held, from, to: to ?? bars[89]!.t + MIN };
      },
    });
    chart.addLayer(vp);
    chart.setViewport({ fitAll: true });
    chart.render();
    const c = chart.coords();
    const place = () => (vp as unknown as { lastSessions: { x0: number; x1: number }[] }).lastSessions[0]!;
    expect(vp.rendered().map((p) => [p.label, p.poc])).toEqual([['Range', GRID.toPrice(GRID.toTick(lo) + 9)]]);
    expect(place().x0).toBeCloseTo(c.xOfIndex(20) - c.barSpacing / 2, 5);
    expect(asked.at(-1)).toBe(bars[60]!.t + MIN);
    const box = vp.placedBox()!;
    expect(box.x).toBeCloseTo(c.xOfIndex(20) - c.barSpacing / 2, 5);
    expect(box.x + box.w).toBeCloseTo(c.xOfIndex(60) + c.barSpacing / 2, 5);
    expect(box.h).toBeGreaterThan(0);
    vp.setOptions({ period: 'session' });
    chart.render();
    expect(vp.placedBox(), 'a period profile is not a placed one').toBeNull();
    vp.setOptions({ period: 'anchored', to: null });
    chart.render();
    expect(asked.at(-1)).toBeNull();
    expect(vp.rendered().map((p) => p.label)).toEqual(['Anchored']);
    vp.setOptions({ period: 'range', from: null, to: null });
    chart.render();
    expect(
      vp.rendered().map((p) => p.label),
      'a range not placed yet covers the bars in view',
    ).toEqual(['Range']);
    expect(asked.at(-1)).toBeNull();
    chart.destroy();
  });
});

describe('delta by price in the volume profile', () => {
  const PROFILE_STYLE = {
    poc: style('#dcebef'),
    vah: style('#6f7c82', { line: 'dot' as const }),
    val: style('#6f7c82', { line: 'dot' as const }),
  };
  const ROWS = 30;
  const sum = (a: Float64Array) => a.reduce((t, v) => t + v, 0);
  const deltaOf = (s: SessionProfileData) => sum(s.buy) - sum(s.sell);

  const skewed = (from: number, to: number, label: string, lo: number, buyShare: number): SessionProfileData => {
    const volume = new Float64Array(ROWS).map((_, k) => 200 + 10 * k);
    const buy = volume.map((v, k) => Math.round(v * (k < ROWS / 2 ? 1 - buyShare : buyShare)));
    return {
      from,
      to,
      label,
      rowTicks: 1,
      lowTick: GRID.toTick(lo),
      rows: ROWS,
      volume,
      buy,
      sell: volume.map((v, k) => v - buy[k]!),
    };
  };

  const merged = (parts: readonly SessionProfileData[]): SessionProfileData => {
    const [first] = parts;
    const add = (key: 'volume' | 'buy' | 'sell') =>
      new Float64Array(ROWS).map((_, k) => parts.reduce((t, p) => t + p[key][k]!, 0));
    return {
      ...first!,
      to: parts.at(-1)!.to,
      label: 'composite',
      volume: add('volume'),
      buy: add('buy'),
      sell: add('sell'),
    };
  };

  const tinted = (chart: ReturnType<typeof chartWith>) => {
    const ctx = chart.canvases.underlay.getContext('2d') as {
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
    };
    const { width: w, height: h } = chart.canvases.underlay;
    const d = ctx.getImageData(0, 0, w, h).data;
    const px = { buy: 0, sell: 0 };
    for (let k = 0; k < d.length; k += 4) {
      if (d[k + 3] === 0) continue;
      const [r, g] = [d[k]!, d[k + 1]!];
      if (g > r + 60) px.buy++;
      if (r > g + 60) px.sell++;
    }
    return px;
  };

  for (const period of ['session', 'day', 'week', 'composite'] as const) {
    it(`draws the ${period} profile's delta alone or beside its volume, and reports it`, () => {
      const { bars } = market(90);
      const lo = Math.min(...bars.map((b) => b.l));
      const parts = [
        skewed(bars[0]!.t, bars[44]!.t + MIN, 'Mon', lo, 0.75),
        skewed(bars[45]!.t, bars[89]!.t + MIN, 'Tue', lo, 0.35),
      ];
      const composite = merged(parts);
      const chart = chartWith(bars);
      chart.setLayerVisible('grid', false);
      chart.setLayerVisible('sessions', false);
      const vp = new VolumeProfileLayer({
        id: 'vp',
        grid: GRID,
        options: { period, compositePeriod: 'session', length: 2, rowTicks: 1, nakedPocs: false },
        style: PROFILE_STYLE,
      });
      vp.setSource({
        periods: (p) => (p === period ? parts : []),
        composite: (n, p) => (period === 'composite' && n === 2 && p === 'session' ? composite : null),
        span: () => null,
      });
      chart.addLayer(vp);
      const drawn = period === 'composite' ? [{ ...composite, label: '2 sessions' }] : parts;
      const shown = (show: ProfileShow) => {
        vp.setOptions({ show });
        chart.render(true);
        return tinted(chart);
      };

      const volume = shown('volume');
      expect(volume.buy + volume.sell, 'volume alone draws no buy or sell tint').toBe(0);
      expect(vp.rendered().map((p) => p.delta)).toEqual(drawn.map(deltaOf));
      expect(vp.legendValues(89, FMT, TESSERA_THEME).map((v) => v.text)).not.toContainEqual(
        expect.stringMatching(/^Δ/),
      );

      const alone = shown('delta');
      expect(alone.buy, 'rows bought into draw in the buy colour').toBeGreaterThan(0);
      expect(alone.sell, 'rows sold into draw in the sell colour').toBeGreaterThan(0);
      expect(vp.rendered().map((p) => [p.label, p.delta])).toEqual(drawn.map((p) => [p.label, deltaOf(p)]));
      const newest = deltaOf(drawn.at(-1)!);
      expect(newest).not.toBe(0);
      expect(vp.legendValues(89, FMT, TESSERA_THEME).at(-1)).toEqual({
        text: `Δ ${signedCount(newest)}`,
        color: newest > 0 ? TESSERA_THEME.flow.deltaUp : TESSERA_THEME.flow.deltaDown,
      });

      const beside = shown('volumeDelta');
      expect(beside.buy).toBeGreaterThan(0);
      expect(beside.sell).toBeGreaterThan(0);
      expect(beside.buy + beside.sell, 'beside volume, delta keeps to a narrow column').toBeLessThan(
        (alone.buy + alone.sell) / 2,
      );
      expect(vp.rendered().map((p) => p.delta)).toEqual(drawn.map(deltaOf));
      chart.destroy();
    });
  }
});

describe('the volume profiles a chart says it drew', () => {
  const PROFILE_STYLE = {
    poc: style('#dcebef'),
    vah: style('#6f7c82', { line: 'dot' as const }),
    val: style('#6f7c82', { line: 'dot' as const }),
  };
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ROWS = 40;

  const barsAt = (times: readonly number[], price = 5800): Bar[] =>
    times.map((t) => ({ t, o: price, h: price + 2, l: price - 2, c: price + 0.5, v: 1000 }));

  const period = (from: number, to: number, label: string, lowPrice = 5795, filled = true): SessionProfileData => {
    const volume = new Float64Array(ROWS).map((_, k) => (filled ? 100 + (k === 12 ? 900 : k) : 0));
    return {
      from,
      to,
      label,
      rowTicks: 1,
      lowTick: GRID.toTick(lowPrice),
      rows: ROWS,
      volume,
      buy: volume.map((v) => v / 2),
      sell: volume.map((v) => v / 2),
    };
  };

  const profileOn = (
    bars: Bar[],
    sessions: readonly SessionProfileData[],
    extra: Parameters<typeof headless>[0] = {},
  ) => {
    const chart = chartWith(bars, extra);
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'session', length: 10, nakedPocs: false },
      style: PROFILE_STYLE,
    });
    vp.setSource({ periods: () => sessions, composite: () => null, span: () => null });
    chart.addLayer(vp);
    chart.render();
    return { chart, vp, labels: () => vp.rendered().map((p) => p.label) };
  };

  it('lists every period it draws on time bars, with what it drew', () => {
    const { bars } = market(90);
    const sessions = [period(bars[0]!.t, bars[44]!.t + MIN, 'Mon'), period(bars[45]!.t, bars[89]!.t + MIN, 'Tue')];
    const { chart, vp, labels } = profileOn(bars, sessions);
    expect(labels()).toEqual(['Mon', 'Tue']);
    expect(vp.rendered()[1]!.poc).toBe(GRID.toPrice(sessions[1]!.lowTick + 12));
    chart.destroy();
  });

  it('draws Length periods back from the newest in view, whatever their names', () => {
    const { bars } = market(400);
    const days = [0, 1, 2, 3, 4, 5, 6, 7].map((k) =>
      period(bars[k * 50]!.t, bars[k * 50 + 49]!.t + MIN, k % 2 ? 'Fri' : 'Thu'),
    );
    const { chart, vp } = profileOn(bars, days);
    const froms = () => vp.rendered().map((p) => p.from);
    vp.setOptions({ length: 2 });
    chart.setViewport({ range: { from: bars[0]!.t, to: bars[399]!.t } });
    chart.render();
    expect(froms()).toEqual([days[6]!.from, days[7]!.from]);
    chart.setViewport({ range: { from: bars[60]!.t, to: bars[140]!.t } });
    chart.render();
    expect(froms(), 'scrolled back, the periods up to the view').toEqual([days[1]!.from, days[2]!.from]);
    chart.destroy();
  });

  it('lists the regular-hours sessions a daily chart draws inside each day’s bar', () => {
    const days = [0, 1, 2, 3, 4].map((k) => Date.UTC(2026, 9, 5 + k));
    const bars = barsAt(days);
    const rth = days.map((d, k) => period(d + 13.5 * HOUR, d + 20 * HOUR, `Day ${String(k)} RTH`));
    const { chart, labels } = profileOn(bars, rth, { timeframeMs: DAY });
    expect(labels().sort()).toEqual(['Day 0 RTH', 'Day 1 RTH', 'Day 2 RTH', 'Day 3 RTH', 'Day 4 RTH']);
    chart.destroy();
  });

  it('lists the sessions a daily chart draws over their bars', () => {
    const days = [0, 1, 2, 3, 4].map((k) => Date.UTC(2026, 9, 5 + k));
    const bars = barsAt(days);
    const eth = days.map((d, k) => period(d - 2 * HOUR, d + 21 * HOUR, `Day ${String(k)}`));
    const { chart, labels } = profileOn(bars, eth, { timeframeMs: DAY });
    expect(labels().sort()).toEqual(['Day 0', 'Day 1', 'Day 2', 'Day 3', 'Day 4']);
    chart.destroy();
  });

  it('lists only the sessions tick bars draw, not one that falls between two bars', () => {
    const times = [
      ...Array.from({ length: 40 }, (_, i) => T0 + i * 7_000),
      ...Array.from({ length: 40 }, (_, i) => T0 + 6 * HOUR + i * 11_000),
    ];
    const bars = barsAt(times);
    const sessions = [
      period(T0, T0 + 40 * 7_000, 'First'),
      period(T0 + HOUR, T0 + 2 * HOUR, 'Between'),
      period(T0 + 6 * HOUR, T0 + 7 * HOUR, 'Last'),
    ];
    const { chart, labels } = profileOn(bars, sessions);
    expect(labels()).toEqual(['First', 'Last']);
    chart.destroy();
  });

  it('lists nothing for a session with no volume read yet', () => {
    const { bars } = market(90);
    const { chart, labels } = profileOn(bars, [period(bars[0]!.t, bars[89]!.t + MIN, 'Mon', 5795, false)]);
    expect(labels()).toEqual([]);
    chart.destroy();
  });

  it('lists nothing for a profile whose prices are all off the visible scale', () => {
    const { bars } = market(90);
    const { chart, labels } = profileOn(bars, [period(bars[0]!.t, bars[89]!.t + MIN, 'Mon', 9000)]);
    expect(labels()).toEqual([]);
    chart.destroy();
  });

  it('lists a fixed range only while some of it is on screen', () => {
    const { bars } = market(400);
    const chart = chartWith(bars);
    const held = period(bars[10]!.t, bars[40]!.t + MIN, '', 5795);
    const vp = new VolumeProfileLayer({
      id: 'vp',
      grid: GRID,
      options: { period: 'range', from: bars[10]!.t, to: bars[40]!.t + MIN, rowTicks: 1 },
      style: PROFILE_STYLE,
    });
    vp.setSource({ periods: () => [], composite: () => null, span: (from, to) => ({ ...held, from, to: to ?? 0 }) });
    chart.addLayer(vp);
    chart.setViewport({ range: { from: bars[0]!.t, to: bars[60]!.t } });
    chart.render();
    expect(vp.rendered().map((p) => p.label)).toEqual(['Range']);
    chart.setViewport({ range: { from: bars[300]!.t, to: bars[399]!.t } });
    chart.render();
    expect(vp.rendered(), 'a range scrolled away is not listed').toEqual([]);
    expect(vp.placedBox()).toBeNull();
    chart.destroy();
  });

  it('forgets what it drew once it draws nothing', () => {
    const { bars } = market(90);
    const { chart, vp, labels } = profileOn(bars, [period(bars[0]!.t, bars[89]!.t + MIN, 'Mon')]);
    expect(labels()).toEqual(['Mon']);
    vp.setSource(null);
    chart.render();
    expect(labels()).toEqual([]);
    chart.destroy();
  });
});

describe('big trades layer', () => {
  type Placed = BigTradeMarker & { label: string; labelPx: number };
  const trade = (k: number, t: number, price: number, size: number, side: 1 | -1): BigTrade => ({
    t,
    price,
    size,
    side,
    prints: 1,
    ref: String(k),
  });
  const sourceOf = (trades: readonly BigTrade[], reference: number) => ({
    reference: () => reference,
    between: (from: number, to: number) => trades.filter((x) => x.t >= from && x.t < to),
  });
  const placedOf = (big: BigTradesLayer) => big.markers() as readonly Placed[];
  const refs = (ms: readonly BigTradeMarker[]) => ms.map((m) => m.trade.ref).sort((a, b) => Number(a) - Number(b));
  const radii = (big: BigTradesLayer) =>
    placedOf(big)
      .map((m) => [m.trade.ref, m.r] as const)
      .sort((a, b) => Number(a[0]) - Number(b[0]));
  const labelWidth = (label: string, px: number) => {
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = bigTradeLabelFont(TESSERA_THEME, px);
    return ctx.measureText(label).width;
  };
  const expectFigureInDisc = (p: Placed, why: string) => {
    expect(sizeSpellings(p.trade.size), `${why}: a figure is its own size`).toContain(p.label);
    expect(p.labelPx, why).toBeGreaterThan(0);
    expect(p.labelPx, why).toBeLessThanOrEqual(10.5);
    const halo = (ORDERFLOW_STYLE.bubbleLabelHalo * p.labelPx) / 10.5;
    const corner = Math.hypot((labelWidth(p.label, p.labelPx) + halo) / 2, (0.75 * p.labelPx + halo) / 2);
    if (p.labelPx > 0.5) expect(corner, `${why}: the figure fits its disc`).toBeLessThanOrEqual(p.r);
  };

  it('sizes a bubble from the bar spacing and its size over R, deterministically', () => {
    const s = ORDERFLOW_STYLE;
    const base = (spacing: number) =>
      Math.min(s.bubbleRadiusMax, Math.max(s.bubbleRadiusMin, s.bubbleRadiusBase + s.bubbleRadiusPerSpacing * spacing));
    expect(bubbleRadius(10, 100, 0.2)).toBe(s.bubbleRadiusMin);
    expect(bubbleRadius(10, 100, 40)).toBe(s.bubbleRadiusMax);
    expect(bubbleRadius(10, 100, 5)).toBe(base(5));
    expect(bubbleRadius(100, 100, 5)).toBe(base(5));
    expect(bubbleRadius(400, 100, 5)).toBeCloseTo(2 * base(5), 9);
    expect(bubbleRadius(1e9, 100, 5)).toBeCloseTo(s.bubbleScaleMax * base(5), 9);
    expect(bubbleRadius(300, 100, 5)).toBeGreaterThan(bubbleRadius(200, 100, 5));
    expect(bubbleRadius(200, 100, 8)).toBeGreaterThan(bubbleRadius(200, 100, 4));
    for (const reference of [Number.NaN, 0, -5, Infinity]) expect(bubbleRadius(400, reference, 5)).toBe(base(5));
    expect(bubbleRadius(Number.NaN, 100, 5)).toBe(base(5));
  });

  it('draws a solid fill with a crisp full-strength ring in the side colour', () => {
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    type Sprite = { canvas: unknown; size: number };
    const sp = (
      big as unknown as {
        sprite(ink: { rgb: string; fill: number; key: string }, r: number, d: number, a: number): Sprite;
      }
    ).sprite({ rgb: ORDERFLOW_STYLE.up, fill: ORDERFLOW_STYLE.bubbleFill, key: 'solid' }, 12, 2, 1);
    const px = (dx: number, dy = 0) => {
      const m = sp.size / 2;
      return (sp.canvas as ReturnType<typeof createCanvas>).getContext('2d').getImageData(m + dx, m + dy, 1, 1).data;
    };
    const ring = [23, 24, 25].map((d) => px(d)).sort((a, b) => b[3]! - a[3]!)[0]!;
    expect(ring[3]! / 255).toBeGreaterThan(0.8);
    expect(ring[1]!).toBeGreaterThan(ring[0]!);
    expect(px(0, 14)[3]! / 255).toBeCloseTo(ORDERFLOW_STYLE.bubbleFill, 1);
    expect(px(0)[3]! / 255, 'no figure baked in').toBeCloseTo(ORDERFLOW_STYLE.bubbleFill, 1);
    expect(px(27)[3]).toBe(0);
  });

  const barOf = (bars: readonly Bar[], t: number) => bars.findIndex((b) => b.t <= t && t < b.t + MIN);
  const sortedRefs = (ts: readonly BigTrade[]) => ts.map((t) => t.ref).sort((a, b) => Number(a) - Number(b));
  const inPaneOf = (chart: ReturnType<typeof chartWith>, bars: readonly Bar[], trades: readonly BigTrade[]) => {
    const c = chart.coords();
    return trades.filter((t) => {
      const x = c.xOfIndex(barOf(bars, t.t));
      const y = c.yOfPrice(t.price);
      return x >= c.plot.x - 20 && x <= c.plot.x + c.plot.w + 20 && y >= c.plot.y - 20 && y <= c.plot.y + c.plot.h + 20;
    });
  };
  const priceOf = (bars: readonly Bar[]) => ({
    min: Math.min(...bars.map((b) => b.l)) - 1,
    max: Math.max(...bars.map((b) => b.h)) + 1,
  });
  const cutoff = ORDERFLOW_STYLE.bubbleLabelSpacingMin;

  type View = Parameters<ReturnType<typeof chartWith>['setViewport']>[0];
  type Scene = {
    bars: Bar[];
    trades: BigTrade[];
    reference: number;
    chart?: Parameters<typeof headless>[0];
    views: View[];
    allInView?: boolean;
    onCentre?: boolean;
  };
  const crowd = (bars: readonly Bar[], n: number, from: number, span: number, size: (k: number) => number) =>
    Array.from({ length: n }, (_, k) => {
      const b = bars[from + (k % span)]!;
      return trade(1000 + k, b.t + 1000 * (k % 50), b.c, size(k), k % 2 ? 1 : -1);
    });
  const fight = (bars: readonly Bar[]) =>
    bars
      .slice(100, 110)
      .flatMap((b, k) => [trade(2 * k, b.t + 20_000, b.c, 300, 1), trade(2 * k + 1, b.t + 20_500, b.c, 40, -1)]);
  const autoLevel = (reference: number): Scene => {
    const { bars } = market(120);
    const sizes = [78, 143, 179, 129, 96, 121, 1_234, 12_480];
    const trades = sizes
      .map((size, k) => trade(k, bars[70 + 6 * k]!.t + 30_000, bars[70 + 6 * k]!.c, size, k % 2 ? 1 : -1))
      .filter((t) => t.size >= reference);
    return {
      bars,
      trades,
      reference,
      chart: { width: 1600, height: 500, dpr: 2 },
      views: [cutoff, 6, 8, 12, 20].map((barSpacing) => ({ barSpacing, rightEdgeSlot: bars.length - 1 })),
      allInView: true,
    };
  };
  const scenes: Record<string, () => Scene> = {
    'two thousand trades over 400 bars': () => {
      const { bars } = market(400);
      return {
        bars,
        trades: Array.from({ length: 2000 }, (_, k) =>
          trade(k, bars[k % 400]!.t + 1000 * (k % 50), bars[k % 400]!.c, 20 + (k % 97) * (k % 7), k % 2 ? 1 : -1),
        ),
        reference: 150,
        views: [{ fitAll: true }, { barSpacing: 3 }, { barSpacing: 12 }, { barSpacing: 0.5 }, { barSpacing: 5 }],
      };
    },
    'a fight on ten candles inside a crowd, on a wide chart': () => {
      const { bars } = market(400);
      return {
        bars,
        trades: [...fight(bars), ...crowd(bars, 600, 10, 390, (k) => 20 + (k % 97))],
        reference: 120,
        chart: { width: 2600 },
        views: [{ fitAll: true }],
      };
    },
    'a fight on ten candles inside a crowd, on a narrow chart': () => {
      const { bars } = market(400);
      return {
        bars,
        trades: [...fight(bars), ...crowd(bars, 600, 10, 390, (k) => 20 + (k % 97))],
        reference: 120,
        views: [{ fitAll: true }],
      };
    },
    'a trade on every fourth of 3,000 bars, up to 9,000 lots': () => {
      const { bars } = market(3_000);
      const price = priceOf(bars);
      return {
        bars,
        trades: bars.flatMap((b, k) =>
          k % 4 ? [] : [trade(k, b.t + 30_000, b.c, 1 + ((k * 37) % 9_000), k % 3 ? 1 : -1)],
        ),
        reference: 120,
        chart: { width: 900, height: 500, dpr: 2 },
        views: [cutoff, 6, 12, 30, cutoff - 0.5, 2]
          .map((barSpacing): View => ({ barSpacing, price }))
          .concat([{ fitAll: true, price }]),
      };
    },
    'Auto Low': () => autoLevel(64),
    'Auto Medium': () => autoLevel(90),
    'Auto High': () => autoLevel(121),
    'Fixed ≥ 100': () => autoLevel(100),
    'one trade on every fourth bar, through a range, a zoom and a scroll': () => {
      const { bars } = market(120);
      const price = priceOf(bars);
      return {
        bars,
        trades: bars
          .slice(40, 80)
          .filter((_, k) => k % 4 === 0)
          .map((b, k) => trade(k, b.t + 30_000, b.c, 60 + 37 * (k % 5), k % 2 ? 1 : -1)),
        reference: 110,
        views: [
          { fitAll: true, price },
          { range: { from: bars[30]!.t, to: bars[90]!.t }, price },
          { barSpacing: 20, rightEdgeSlot: 86, price },
        ],
        allInView: true,
      };
    },
    'three trades far apart at the right edge, from 5 to 80 px bars': () => {
      const { bars } = market(200);
      const last = bars.length - 1;
      const p0 = GRID.toTick(bars[last]!.c);
      const trades = [last - 2, last - 1, last].map((i, k) =>
        trade(k, bars[i]!.t + 30_000, GRID.toPrice(p0 + 40 * k), [60, 300, 900][k]!, k % 2 ? 1 : -1),
      );
      const price = {
        min: Math.min(...trades.map((t) => t.price)) - 10,
        max: Math.max(...trades.map((t) => t.price)) + 10,
      };
      return {
        bars,
        trades,
        reference: 120,
        chart: { width: 900, height: 500, dpr: 1 },
        views: [5, 8, 12, 20, 40, 80].map((barSpacing) => ({ barSpacing, rightEdgeSlot: last, price })),
        allInView: true,
        onCentre: true,
      };
    },
  };

  it.each(Object.keys(scenes))(
    'places every trade in view as its own bubble at its candle and price, sized by R, largest first, its figure inside it from 5 px bars: %s',
    (name) => {
      const scene = scenes[name]!();
      const chart = chartWith(scene.bars, scene.chart);
      const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
      big.setSource({ reference: () => scene.reference, between: () => scene.trades });
      chart.addLayer(big);
      for (const view of scene.views) {
        chart.setViewport(view);
        chart.render(true);
        const why = `${name} at ${JSON.stringify(view)}`;
        const c = chart.coords();
        const barSpacing = chart.getViewport().barSpacing;
        const placed = placedOf(big);
        const expected = scene.allInView ? scene.trades : inPaneOf(chart, scene.bars, scene.trades);
        expect(expected.length, why).toBeGreaterThan(0);
        expect(refs(placed), why).toEqual(sortedRefs(expected));
        expect(
          placed.every((p, k) => k === 0 || p.trade.size <= placed[k - 1]!.trade.size),
          why,
        ).toBe(true);
        for (const p of placed) {
          const centre = c.xOfIndex(barOf(scene.bars, p.trade.t));
          if (scene.onCentre) expect(p.x, `${why}: on its candle centre`).toBe(centre);
          else
            expect(p.x, `${why}: its candle centre, or nudged right off a bigger bubble`).toBeGreaterThanOrEqual(
              centre,
            );
          expect(p.y, `${why}: its price`).toBeCloseTo(c.yOfPrice(p.trade.price), 6);
          expect(p.r, `${why}: never stretched for the figure`).toBe(
            bubbleRadius(p.trade.size, scene.reference, barSpacing),
          );
          if (barSpacing >= cutoff) expectFigureInDisc(p, `${why}, size ${String(p.trade.size)}`);
          else expect(p.label, `${why}: no figure under ${String(cutoff)} px bars`).toBe('');
        }
      }
      chart.destroy();
    },
  );

  it('paints every bubble smallest first, then the figures, largest last, and sorts the trades once across renders', () => {
    const { bars, trades, reference } = scenes['two thousand trades over 400 bars']!();
    const chart = chartWith(bars);
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    let calls = 0;
    big.setSource({
      reference: () => reference,
      between: () => {
        calls++;
        return trades;
      },
    });
    chart.addLayer(big);
    const ctx = chart.canvases.main.getContext('2d') as CanvasRenderingContext2D;
    const painted: { image: unknown; x: number; y: number }[] = [];
    const drawImage = ctx.drawImage.bind(ctx) as (...a: unknown[]) => void;
    (ctx as unknown as { drawImage: (...a: unknown[]) => void }).drawImage = (...a) => {
      const [image, x, y, w, h] = a as [unknown, number, number, number, number];
      painted.push({ image, x: x + w / 2, y: y + h / 2 });
      drawImage(...a);
    };
    const figureImages = () =>
      new Set(
        [...(big as unknown as { labelSprites: Map<string, { canvas: unknown }> }).labelSprites.values()].map(
          (sp) => sp.canvas,
        ),
      );
    const layerDraw = big.draw.bind(big);
    let ownPaint: typeof painted = [];
    big.draw = (rc) => {
      painted.length = 0;
      layerDraw(rc);
      ownPaint = [...painted];
    };
    for (const view of [{ barSpacing: 3 }, { barSpacing: 12 }]) {
      chart.setViewport(view);
      chart.render(true);
      const placed = placedOf(big);
      const withFigures = placed.filter((p) => p.label).reverse();
      const figureImage = figureImages();
      expect(ownPaint.map((d) => (figureImage.has(d.image) ? 'label' : 'bubble'))).toEqual([
        ...placed.map(() => 'bubble'),
        ...withFigures.map(() => 'label'),
      ]);
      const figures = ownPaint.slice(placed.length);
      withFigures.forEach((p, k) => {
        expect(Math.abs(figures[k]!.x - p.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(figures[k]!.y - p.y)).toBeLessThanOrEqual(1);
      });
    }
    const top = placedOf(big)[0]!;
    expect(big.askTarget(top.x, top.y)?.kind).toBe('bubble');
    const sorted = (big as unknown as { sorted: { order: BigTrade[] } }).sorted.order;
    chart.render();
    expect(calls).toBeGreaterThan(0);
    expect((big as unknown as { sorted: { order: BigTrade[] } }).sorted.order).toBe(sorted);
    chart.destroy();
  });

  it('keeps both sides of a fight reachable: the smaller nudged clear at the same price, a crowded spot hovering every bubble under it', () => {
    const wide = scenes['a fight on ten candles inside a crowd, on a wide chart']!();
    const chart = chartWith(wide.bars, wide.chart);
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource(sourceOf(wide.trades, wide.reference));
    chart.addLayer(big);
    chart.setViewport({ fitAll: true });
    chart.render();
    const placed = placedOf(big);
    const sell = placed.find((m) => m.trade.ref === '1')!;
    const buy = placed.find((m) => m.trade.ref === '0')!;
    expect(sell.y).toBe(buy.y);
    expect(Math.abs(sell.x - buy.x), 'the smaller of the fight is nudged clear').toBeGreaterThan(0);
    expect(big.markersAt(sell.x, sell.y).map((m) => m.trade.ref)).toContain('1');
    expect(big.markersAt(buy.x, buy.y).map((m) => m.trade.ref)).toContain('0');
    chart.destroy();

    const narrow = scenes['a fight on ten candles inside a crowd, on a narrow chart']!();
    const small = chartWith(narrow.bars);
    const crowded = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    crowded.setSource(sourceOf(narrow.trades, narrow.reference));
    small.addLayer(crowded);
    small.setViewport({ fitAll: true });
    small.render();
    const ms = placedOf(crowded);
    const [a, b] = ms
      .flatMap((p, k) => ms.slice(k + 1).map((q) => [p, q] as const))
      .find(([p, q]) => {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        return d > 1 && d < Math.min(p.r, q.r) + Math.max(p.r, q.r) - 1;
      })!;
    const larger = a.r >= b.r ? a : b;
    const smaller = larger === a ? b : a;
    const len = Math.hypot(larger.x - smaller.x, larger.y - smaller.y);
    const d = Math.max(0, len - larger.r + 0.5);
    const at = { x: smaller.x + ((larger.x - smaller.x) / len) * d, y: smaller.y + ((larger.y - smaller.y) / len) * d };
    const here = crowded.markersAt(at.x, at.y);
    expect(here).toEqual(expect.arrayContaining([smaller, larger]));
    expect(here.map((m) => m.r)).toEqual([...here.map((m) => m.r)].sort((x, y) => x - y));
    expect(crowded.askTarget(at.x, at.y)?.label).toBe('these big trades');
    small.destroy();
  });

  it('grows the bubbles as bars widen, and keeps their pixels on a taller price scale', () => {
    const { bars, trades, reference } =
      scenes['one trade on every fourth bar, through a range, a zoom and a scroll']!();
    const chart = chartWith(bars);
    const big = new BigTradesLayer({
      id: 'bt',
      options: { showSize: false },
      createCanvas: (w, h) => createCanvas(w, h),
    });
    big.setSource(sourceOf(trades, reference));
    chart.addLayer(big);
    const { min: lo, max: hi } = priceOf(bars);
    const widest = (view: View) => {
      chart.setViewport(view);
      chart.render(true);
      return Math.max(...placedOf(big).map((m) => m.r));
    };
    expect(widest({ barSpacing: 20, rightEdgeSlot: 86, price: { min: lo, max: hi } })).toBeGreaterThan(
      widest({ fitAll: true, price: { min: lo, max: hi } }),
    );
    const before = radii(big);
    widest({ fitAll: true, price: { min: lo, max: lo + 2 * (hi - lo) } });
    expect(radii(big)).toEqual(before);
    chart.destroy();
  });

  describe('overlapping bubbles', () => {
    const SPACING = 12;
    const setup = (share: number) => {
      const { bars } = market(60);
      const chart = chartWith(bars, { width: 900, height: 500, dpr: 1 });
      const bar = bars[30]!;
      const bigR = bubbleRadius(107, 50, SPACING);
      const smallR = bubbleRadius(67, 50, SPACING);
      const trades = [trade(1, bar.t + 1000, bar.c, 107, 1), trade(2, bar.t + 2000, bar.c, 67, -1)];
      const big = new BigTradesLayer({
        id: 'bt',
        options: { showSize: false },
        createCanvas: (w, h) => createCanvas(w, h),
      });
      chart.addLayer(big);
      chart.setViewport({
        barSpacing: SPACING,
        price: { min: Math.min(...bars.map((b) => b.l)) - 400, max: Math.max(...bars.map((b) => b.h)) + 400 },
      });
      const bigY = chart.coords().yOfPrice(bar.c);
      let best = Number.POSITIVE_INFINITY;
      let bestPrice = bar.c;
      for (let k = 0; k <= 200; k++) {
        const price = bar.c - k * 0.25;
        const d = Math.abs(chart.coords().yOfPrice(price) - bigY);
        const gap = Math.abs(overlapShare(d, smallR, bigR) - share);
        if (gap < best) {
          best = gap;
          bestPrice = price;
        }
      }
      trades[1] = { ...trades[1]!, price: bestPrice };
      big.setSource(sourceOf(trades, 50));
      chart.render(true);
      const c = chart.coords();
      return { chart, big, centre: c.xOfIndex(30), bigR, smallR };
    };
    const byRef = (big: BigTradesLayer, ref: string) => placedOf(big).find((p) => p.trade.ref === ref)!;

    it('measures the share of the smaller bubble the bigger one covers', () => {
      expect(overlapShare(0, 5, 9)).toBe(1);
      expect(overlapShare(20, 5, 9)).toBe(0);
      expect(overlapShare(4, 5, 9)).toBe(1);
      expect(overlapShare(7, 5, 9)).toBeGreaterThan(0.5);
      expect(overlapShare(7, 5, 9)).toBeLessThan(1);
    });

    it('nudges the smaller bubble right of a bigger one it overlaps by ~85%, keeping both hit-testable', () => {
      const { chart, big, centre, bigR, smallR } = setup(0.85);
      const large = byRef(big, '1');
      const small = byRef(big, '2');
      expect(large.x).toBe(centre);
      expect(small.x).toBeGreaterThan(centre);
      expect(small.x - centre).toBeLessThan(bigR);
      expect(overlapShare(Math.hypot(small.x - large.x, small.y - large.y), smallR, bigR)).toBeLessThanOrEqual(0.8);
      expect(big.markersAt(small.x, small.y)[0]!.trade.ref, 'the top one wins the hover').toBe('2');
      expect(refs(big.markersAt(large.x - bigR + 2, large.y)), 'the bigger one is still reachable').toEqual(['1']);
      expect(big.hitTest(small.x, small.y)?.objectId).toBe('2');
      chart.destroy();
    });

    it('leaves bubbles that overlap by ~50% exactly where they are', () => {
      const { chart, big, centre } = setup(0.5);
      expect(byRef(big, '1').x).toBe(centre);
      expect(byRef(big, '2').x).toBe(centre);
      chart.destroy();
    });
  });

  it('gives a trade the same radius whatever else is in view', () => {
    const { bars } = market(120);
    const chart = chartWith(bars);
    const mine = trade(1, bars[60]!.t + 30_000, bars[60]!.c, 140, 1);
    const crowd = Array.from({ length: 300 }, (_, k) =>
      trade(
        100 + k,
        bars[1 + (k % 59) * 2]!.t + 1000 * (k % 50),
        bars[1 + (k % 59) * 2]!.c,
        30 + 500 * (k % 3),
        k % 2 ? 1 : -1,
      ),
    );
    const radiusWith = (others: readonly BigTrade[], reference: number) => {
      const big = new BigTradesLayer({
        id: 'bt',
        options: { showSize: false },
        createCanvas: (w, h) => createCanvas(w, h),
      });
      big.setSource(sourceOf([mine, ...others], reference));
      chart.addLayer(big);
      chart.render(true);
      const r = big.markers().find((m) => m.trade.ref === '1')!.r;
      chart.removeLayer('bt');
      return r;
    };
    chart.setViewport({ fitAll: true });
    const alone = radiusWith([], 100);
    expect(alone).toBeGreaterThan(0);
    expect(radiusWith(crowd, 100)).toBe(alone);
    expect(radiusWith(crowd.slice(0, 7), 100)).toBe(alone);
    expect(radiusWith(crowd, 100)).toBe(alone);
    expect(radiusWith(crowd, 70), 'R is the only thing that moves it').toBeGreaterThan(alone);
    chart.destroy();
  });

  it('spells a size in full while it fits at full size, else picks the spelling that reads largest', () => {
    const widthOf = labelWidth;
    expect(sizeSpellings(143)).toEqual(['143']);
    expect(sizeSpellings(1_234)).toEqual(['1,234', '1.2k']);
    expect(sizeSpellings(12_480)).toEqual(['12.5k']);
    expect(sizeSpellings(1_240_000)).toEqual(['1,240k', '1.2M']);
    expect(fitBubbleLabel(143, 30, widthOf)).toEqual({ text: '143', px: 10.5 });
    expect(fitBubbleLabel(1_234, 30, widthOf)).toEqual({ text: '1,234', px: 10.5 });
    const tight = fitBubbleLabel(1_234, 8, widthOf);
    expect(tight.text).toBe('1.2k');
    expect(tight.px).toBeLessThan(10.5);
    const small = fitBubbleLabel(143, 4, widthOf);
    expect(small.text).toBe('143');
    expect(small.px).toBeGreaterThan(0);
    expect(small.px).toBeLessThan(fitBubbleLabel(143, 8, widthOf).px);
  });

  it('writes no size while Show size is off, and the bubbles go back to their plain radius', () => {
    const { bars } = market(40);
    const chart = chartWith(bars);
    const trades = bars.slice(5, 35).map((b, k) => trade(k, b.t + 30_000, b.c, 100 + 40 * k, k % 2 ? 1 : -1));
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource(sourceOf(trades, 300));
    chart.addLayer(big);
    chart.setViewport({ fitAll: true });
    chart.render(true);
    expect(big.options.showSize).toBe(true);
    expect(placedOf(big).some((m) => m.label !== '')).toBe(true);
    big.setOptions({ showSize: false });
    chart.render(true);
    expect(placedOf(big)).toHaveLength(trades.length);
    for (const m of placedOf(big)) {
      expect(m.label).toBe('');
      expect(m.r).toBe(bubbleRadius(m.trade.size, 300, chart.getViewport().barSpacing));
    }
    chart.destroy();
  });

  it('plots a bubble at its average rounded to a tick by default, or its first price, or its last', () => {
    const { bars } = market(40);
    const chart = chartWith(bars);
    const at = bars[20]!;
    const sweep = { ...trade(1, at.t + 30_000, 5800.1, 40, 1), firstPrice: 5799.5, lastPrice: 5801 };
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource(sourceOf([sweep], 100));
    chart.addLayer(big);
    chart.setViewport({ fitAll: true, price: { min: 5790, max: 5810 } });
    const yAt = () => {
      chart.render(true);
      return big.markers()[0]!.y;
    };
    expect(yAt()).toBeCloseTo(chart.coords().yOfPrice(5800), 6);
    for (const [at, price] of [
      ['start', 5799.5],
      ['last', 5801],
      ['vwap', 5800],
    ] as const) {
      big.setOptions({ price: at });
      expect(yAt(), at).toBeCloseTo(chart.coords().yOfPrice(price), 6);
    }
    chart.destroy();
  });

  it('draws plain-radius bubbles and paints no empty sprite while the feed has no usable R', () => {
    const { bars } = market(40);
    const chart = chartWith(bars);
    const at = bars[20]!;
    const sprites: [number, number][] = [];
    const big = new BigTradesLayer({
      id: 'bt',
      options: { showSize: false },
      createCanvas: (w, h) => {
        sprites.push([w, h]);
        return createCanvas(w, h);
      },
    });
    chart.addLayer(big);
    chart.setViewport({ fitAll: true });
    for (const reference of [Number.NaN, 0, -5, Infinity]) {
      big.setSource(sourceOf([trade(1, at.t + 30_000, at.c, 40, 1)], reference));
      chart.render(true);
      expect(radii(big), `R ${String(reference)}`).toEqual([['1', bubbleRadius(1, 0, chart.getViewport().barSpacing)]]);
    }
    expect(sprites.length).toBeGreaterThan(0);
    expect(
      sprites.every(([w, h]) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0),
      'no empty sprite',
    ).toBe(true);
    chart.destroy();
  });

  describe.each([
    ['on the dark ground', TESSERA_THEME.background],
    ['on a light ground', '#f6f9f9'],
  ])('a hovered bubble keeps its side’s colour over the candle under it, %s', (_, background) => {
    it('draws it solid in its own hue with a heavier ring, the others as they were', () => {
      const { bars } = market(40);
      const chart = chartWith(bars, { theme: { background } });
      const at = bars[20]!;
      const mid = (at.h + at.l) / 2;
      const big = new BigTradesLayer({
        id: 'bt',
        options: { showSize: false },
        createCanvas: (w, h) => createCanvas(w, h),
      });
      big.setSource(
        sourceOf(
          [
            trade(1, at.t + 30_000, mid, 300, 1),
            trade(2, bars[24]!.t + 30_000, (bars[24]!.h + bars[24]!.l) / 2, 300, -1),
          ],
          100,
        ),
      );
      chart.addLayer(big);
      chart.setViewport({ fitAll: true });
      chart.render(true);
      expect(big.markers().map((m) => m.trade.side)).toEqual(expect.arrayContaining([1, -1]));
      const ctx = chart.canvases.main.getContext('2d') as {
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
      const px = (x: number, y: number) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
      const ground = (background.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16));
      const expected = (side: string) =>
        side
          .split(',')
          .map(Number)
          .map((v, i) => ORDERFLOW_STYLE.bubbleFill * v + (1 - ORDERFLOW_STYLE.bubbleFill) * ground[i]!);
      for (const m of big.markers()) {
        const side = m.trade.side > 0 ? ORDERFLOW_STYLE.up : ORDERFLOW_STYLE.down;
        const before = px(m.x, m.y - m.r / 2);
        big.setHovered(m.trade.ref);
        chart.render(true);
        const fill = px(m.x, m.y - m.r / 2);
        expect(
          fill.slice(0, 3).every((v, i) => Math.abs(v - expected(side)[i]!) <= 3),
          `${m.trade.side > 0 ? 'buy' : 'sell'}: ${String(fill)} is its side over the ground, not the candle (${String(before)})`,
        ).toBe(true);
        expect(fill[3]).toBe(255);
        expect(fill, 'the hover shows').not.toEqual(before);
        const ring = px(m.x + m.r, m.y);
        expect(Math.abs(ring[0]! - Number(side.split(',')[0])), 'the ring in the full hue').toBeLessThanOrEqual(40);
        big.setHovered(null);
        chart.render(true);
        expect(px(m.x, m.y - m.r / 2), 'back as it was').toEqual(before);
      }
      chart.destroy();
    });
  });

  describe.each([
    ['the default theme tints the disc', undefined, 0.25, 0.6],
    [
      'an opaque colour draws the solid disc',
      { ...TESSERA_THEME.flow, bubbleBuy: '#2fd3b4', bubbleSell: '#e0523f' },
      ORDERFLOW_STYLE.bubbleFill,
      0.8,
    ],
  ])(
    'fills a bubble in its side’s colour at that colour’s opacity and rings it in the full hue: %s',
    (_, flow, fillAlpha, ringAlpha) => {
      it('draws the disc and the ring', () => {
        const { bars } = market(40);
        const chart = chartWith(bars, flow ? { theme: { flow } } : {});
        const top = Math.max(...bars.map((b) => b.h));
        const at = bars[20]!;
        const big = new BigTradesLayer({
          id: 'bt',
          options: { showSize: false },
          createCanvas: (w, h) => createCanvas(w, h),
        });
        big.setSource(
          sourceOf([trade(1, at.t + 30_000, top + 6, 200, 1), trade(2, at.t + 30_000, top + 12, 200, -1)], 100),
        );
        chart.addLayer(big);
        chart.setViewport({ fitAll: true, price: { min: top + 2, max: top + 16 } });
        chart.render(true);
        const ctx = chart.canvases.main.getContext('2d') as {
          getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
        };
        const px = (m: { x: number; y: number }, dx: number) =>
          ctx.getImageData(Math.round(m.x + dx), Math.round(m.y), 1, 1).data;
        expect(big.markers()).toHaveLength(2);
        for (const m of big.markers()) {
          const side = (m.trade.side > 0 ? ORDERFLOW_STYLE.up : ORDERFLOW_STYLE.down).split(',').map(Number);
          const fill = px(m, Math.round(m.r / 2));
          expect(m.r).toBe(bubbleRadius(200, 100, chart.getViewport().barSpacing));
          expect(
            [...fill.slice(0, 3)].every((v, i) => Math.abs(v - side[i]!) <= 6),
            'in the side’s colour',
          ).toBe(true);
          expect(fill[3]! / 255, 'disc opacity').toBeCloseTo(fillAlpha, 1);
          const ring = Math.max(...[-2, -1, 0, 1, 2].map((d) => px(m, m.r + d)[3]!)) / 255;
          expect(ring, 'ring').toBeGreaterThan(ringAlpha);
          expect(px(m, m.r + 5)[3], 'nothing outside').toBe(0);
        }
        chart.destroy();
      });
    },
  );

  it('zoomed out over days, keeps the candles in sight under hundreds of big trades, each bubble on its own bar', () => {
    const { bars } = market(900, 11);
    const chart = chartWith(bars, { width: 1400, height: 520, dpr: 1 });
    const lo = Math.min(...bars.map((b) => b.l)) - 1;
    const hi = Math.max(...bars.map((b) => b.h)) + 1;
    chart.setViewport({ fitAll: true, price: { min: lo, max: hi } });
    chart.render(true);
    const ctx = chart.canvases.main.getContext('2d') as CanvasRenderingContext2D;
    const { width: w, height: h } = chart.canvases.main;
    const ground = [...ctx.getImageData(2, 2, 1, 1).data];
    const candles = ctx.getImageData(0, 0, w, h).data.slice();
    const lit = (d: Uint8ClampedArray, k: number) => [0, 1, 2].some((c) => Math.abs(d[k + c]! - ground[c]!) > 40);
    const trades = bars.flatMap((b, i) =>
      i % 2
        ? []
        : [
            trade(3 * i, b.t + 10_000, b.c, 60 + ((i * 37) % 240), 1),
            trade(3 * i + 1, b.t + 20_000, b.l, 60 + ((i * 53) % 180), -1),
            trade(3 * i + 2, b.t + 40_000, b.h, 60 + ((i * 29) % 300), i % 4 ? 1 : -1),
          ],
    );
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (cw, ch) => createCanvas(cw, ch) });
    big.setSource(sourceOf(trades, 100));
    chart.addLayer(big);
    chart.render(true);
    const drawn = ctx.getImageData(0, 0, w, h).data;
    const plot = chart.coords().plot;
    let candle = 0;
    let buried = 0;
    for (let k = 0; k < candles.length; k += 4) {
      const x = (k / 4) % w;
      const y = Math.floor(k / 4 / w);
      if (x < plot.x || x >= plot.x + plot.w || y < plot.y || y >= plot.y + plot.h || !lit(candles, k)) continue;
      candle++;
      if ([0, 1, 2].some((c) => Math.abs(drawn[k + c]! - candles[k + c]!) > 40)) buried++;
    }
    expect(chart.getViewport().barSpacing).toBeLessThan(ORDERFLOW_STYLE.bubbleLabelSpacingMin);
    expect(buried / candle, 'candle pixels a bubble paints over').toBeLessThan(0.3);
    const placed = placedOf(big);
    expect(placed.every((p) => p.label === '')).toBe(true);
    const biggest = trades.reduce((a, b) => (b.size > a.size ? b : a));
    expect(refs(placed)).toContain(biggest.ref);
    for (const p of placed) {
      const i = bars.findLastIndex((b) => b.t <= p.trade.t);
      expect(p.x, 'each bubble on its own candle').toBeGreaterThanOrEqual(chart.coords().xOfTime(bars[i]!.t)!);
    }
    chart.destroy();
  });

  it('zoomed fully out keeps every event’s own small disc, one sprite each, none dropped or moved', () => {
    const { bars } = market(3_000);
    const chart = chartWith(bars, { width: 900, height: 500, dpr: 2 });
    const lo = Math.min(...bars.map((b) => b.l)) - 1;
    const hi = Math.max(...bars.map((b) => b.h)) + 1;
    chart.setViewport({ fitAll: true, price: { min: lo, max: hi } });
    const { from, to } = chart.getViewport();
    const trades = bars
      .slice(from + 100, to + 1)
      .filter((_, i) => i % 3 === 0)
      .map((b, k) => trade(k, b.t + 30_000, b.c, k % 2 ? 400 + k : 4, k % 3 ? 1 : -1));
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource(sourceOf(trades, 200));
    chart.addLayer(big);
    const ctx = chart.canvases.main.getContext('2d') as CanvasRenderingContext2D;
    const drawImage = ctx.drawImage.bind(ctx) as (...a: unknown[]) => void;
    let draws = 0;
    (ctx as unknown as { drawImage: (...a: unknown[]) => void }).drawImage = (...a) => {
      draws++;
      drawImage(...a);
    };
    const layerDraw = big.draw.bind(big);
    let layerDraws = 0;
    big.draw = (rc) => {
      layerDraws++;
      layerDraw(rc);
    };
    chart.render(true);
    draws = 0;
    layerDraws = 0;
    chart.render(true);
    expect(chart.getViewport().barSpacing * 2).toBeLessThan(1);
    expect(trades.length).toBeGreaterThan(500);
    const placed = placedOf(big);
    expect(placed.length).toBe(trades.length);
    expect(placed[0]!.trade.size).toBe(Math.max(...trades.map((t) => t.size)));
    const anchor = chart.coords();
    for (const p of placed) {
      const i = bars.findIndex((b) => b.t <= p.trade.t && p.trade.t < b.t + MIN);
      expect(p.x, 'its candle centre, or nudged right').toBeGreaterThanOrEqual(anchor.xOfIndex(i));
      expect(p.y, 'its price').toBeCloseTo(anchor.yOfPrice(p.trade.price), 6);
    }
    expect(draws / layerDraws).toBe(placed.length);
    expect(placed.every((m) => m.r >= ORDERFLOW_STYLE.bubbleRadiusMin && m.label === '')).toBe(true);
    chart.destroy();
  });

  it('puts the same trade on the same pixel of its candle before and after a pan, and keeps its price through a zoom', () => {
    const { bars } = market(400);
    const chart = chartWith(bars);
    const trades = bars
      .slice(60, 340)
      .filter((_, k) => k % 3 === 0)
      .map((b, k) => trade(k, b.t + 30_000, b.c, 40 + 20 * (k % 7), k % 2 ? 1 : -1));
    const big = new BigTradesLayer({ id: 'bt' });
    big.setSource(sourceOf(trades, 120));
    chart.addLayer(big);
    const spots = (view: Parameters<typeof chart.setViewport>[0]) => {
      chart.setViewport(view);
      chart.render(true);
      const c = chart.coords();
      return new Map(
        placedOf(big).map((m) => {
          const i = bars.findIndex((b) => b.t <= m.trade.t && m.trade.t < b.t + MIN);
          return [m.trade.ref, [m.x - c.xOfIndex(i), m.y, m.r] as const];
        }),
      );
    };
    const lo = Math.min(...bars.map((b) => b.l)) - 1;
    const hi = Math.max(...bars.map((b) => b.h)) + 1;
    const price = { min: lo, max: hi };
    const wide = spots({ barSpacing: 12, rightEdgeSlot: 300, price });
    const panned = spots({ barSpacing: 12, rightEdgeSlot: 280, price });
    for (const [ref, spot] of wide) {
      if (!panned.has(ref)) continue;
      expect(panned.get(ref)![0], `trade ${ref} stays on its candle through the pan`).toBe(spot[0]);
      expect(panned.get(ref)![1], `trade ${ref} stays at its price through the pan`).toBe(spot[1]);
    }
    expect(panned.size).toBeGreaterThan(10);
    const zoomed = spots({ barSpacing: 20, rightEdgeSlot: 280, price });
    for (const [ref, spot] of panned) {
      if (!zoomed.has(ref)) continue;
      expect(zoomed.get(ref)![0], `trade ${ref} stays on its candle through the zoom`).toBe(spot[0]);
      expect(zoomed.get(ref)![1], `trade ${ref} stays at its price through the zoom`).toBe(spot[1]);
    }
    chart.destroy();
  });

  it('centres each bubble on its candle’s stem at its price over the footprint, capped to its bar plus a slight spill, never slid aside', () => {
    const { bars, footprints } = market(40);
    const chart = chartWith(bars);
    const store = new FootprintStore(GRID);
    store.setHistory(footprints);
    const fp = new FootprintLayer({ id: 'fp' });
    fp.setStore(store);
    chart.addLayer(fp);
    const mid = (b: Bar) => GRID.toPrice(Math.round((GRID.toTick(b.h) + GRID.toTick(b.l)) / 2));
    const trades = bars.flatMap((b, k) => [
      trade(3 * k, b.t + 45_000, b.h, 80 + 40 * (k % 5), 1),
      trade(3 * k + 1, b.t + 15_000, b.l, 60 + 30 * (k % 4), -1),
      trade(3 * k + 2, b.t + 30_000, mid(b), 120, k % 2 ? 1 : -1),
    ]);
    const big = new BigTradesLayer({ id: 'bt' });
    big.setSource(sourceOf(trades, 100));
    chart.addLayer(big);
    let narrowest = 90;
    for (let spacing = 89; spacing > 20; spacing--) {
      chart.setViewport({ barSpacing: spacing });
      chart.render(true);
      if (fp.lod < 2) break;
      narrowest = spacing;
    }
    const LANE_MIN = 2.5;
    const CELL_SPILL = 3;
    for (const barSpacing of [90, narrowest]) {
      chart.setViewport({ barSpacing });
      chart.render(true);
      expect(fp.lod).toBeGreaterThanOrEqual(2);
      const c = chart.coords();
      const placed = placedOf(big);
      expect(placed.length).toBeGreaterThan(6);
      for (const m of placed) {
        const bar = bars.findIndex((b) => b.t <= m.trade.t && m.trade.t < b.t + MIN);
        const stemX = c.xOfIndex(bar) - barSpacing / 2 + STEM_X_PX + STEM_BODY_PX / 2;
        expect(m.x, 'on the candle stem, not beside the figures').toBeCloseTo(stemX, 6);
        expect(m.y).toBeGreaterThanOrEqual(c.yOfPrice(bars[bar]!.h) - 1e-6);
        expect(m.y).toBeLessThanOrEqual(c.yOfPrice(bars[bar]!.l) + 1e-6);
        const cap = Math.max(LANE_MIN, barSpacing / 2 + CELL_SPILL);
        expect(m.r, 'capped to its bar plus a slight spill').toBeLessThanOrEqual(cap + 1e-6);
        expect(m.r).toBe(Math.max(LANE_MIN, Math.min(bubbleRadius(m.trade.size, 100, barSpacing), cap)));
        expectFigureInDisc(m, `footprint at ${String(barSpacing)} px`);
      }
    }
    chart.destroy();
  });

  it('never sums a pile at one price: each trade keeps its own disc at the same point at every zoom', () => {
    const { bars } = market(60);
    const chart = chartWith(bars);
    const last = bars.length - 1;
    const pile = [
      trade(1, bars[last]!.t + 1000, bars[last]!.c, 100, 1),
      trade(2, bars[last]!.t + 4000, bars[last]!.c, 50, 1),
      trade(3, bars[last]!.t + 9000, bars[last]!.c, 30, 1),
    ];
    const lone = trade(4, bars[last - 1]!.t + 1000, bars[last - 1]!.c, 40, -1);
    const big = new BigTradesLayer({ id: 'bt', createCanvas: (w, h) => createCanvas(w, h) });
    big.setSource(sourceOf([...pile, lone], 100));
    chart.addLayer(big);
    for (const barSpacing of [5, 8, 14, 30]) {
      chart.setViewport({ barSpacing });
      chart.render(true);
      const c = chart.coords();
      const placed = placedOf(big);
      expect(placed).toHaveLength(4);
      for (const m of placed) {
        const bar = bars.findIndex((b) => b.t <= m.trade.t && m.trade.t < b.t + MIN);
        expect(m.x).toBeGreaterThanOrEqual(c.xOfIndex(bar));
        expect(m.y).toBeCloseTo(c.yOfPrice(m.trade.price), 6);
        expect(m.r).toBe(bubbleRadius(m.trade.size, 100, barSpacing));
      }
      const at = placed.filter((m) => m.trade.ref !== '4');
      expect(new Set(at.map((m) => m.y)).size, 'the pile shares one price').toBe(1);
      expect(new Set(at.map((m) => m.x)).size, 'each of the pile is nudged clear of the bigger one').toBe(at.length);
      for (const m of placed) expectFigureInDisc(m, `${String(barSpacing)} px bars`);
      const only = placed.find((m) => m.trade.ref === '4')!;
      expect(only.x).toBeCloseTo(c.xOfIndex(last - 1), 6);
      expect(only.x + only.r).toBeLessThanOrEqual(c.plot.x + c.plot.w + 1e-6);
    }
    chart.destroy();
  });

  it('words one bubble as one event: its size in fills, first to last price and duration', () => {
    const price = (p: number) => p.toLocaleString('en-US', { minimumFractionDigits: 2 });
    const sliced: BigTrade = {
      t: 0,
      price: 20_635.5,
      size: 492,
      side: 1,
      prints: 18,
      ref: 'r',
      firstPrice: 20_627.75,
      lastPrice: 20_643,
      durationMs: 1200,
      tier: 'high',
      levels: 9,
      orders: 3,
    };
    expect(bigTradeWords(sliced, price)).toBe(
      'Buy 492 in 18 fills · 20,627.75–20,643.00 · 1.2 s · 9 levels · 3 orders',
    );
    const one = { ...sliced, side: -1 as const, size: 40, prints: 1, levels: 1, orders: 1, lastPrice: 20_627.75 };
    expect(bigTradeWords({ ...one, durationMs: 0, tier: 'medium' }, price), 'no tier word').toBe(
      'Sell 40 in 1 fill · 20,627.75 · 0 ms',
    );
    expect(bigTradeWords({ ...one, durationMs: 340 }, price)).toBe('Sell 40 in 1 fill · 20,627.75 · 340 ms');
  });

  it('adds what happened next as its own words, and nothing while it is undecided', () => {
    const at = (kind: 'absorbed' | 'pushed' | 'neither', reachTicks: number, withinMs: number): BigTrade => ({
      ...trade(1, 0, 5800, 60, 1),
      outcome: { kind, reachTicks, withinMs },
    });
    expect(bigTradeOutcomeWords(at('absorbed', 6, 12_000))).toBe('Absorbed: price came back 6 ticks within 12 s');
    expect(bigTradeOutcomeWords(at('pushed', 6, 8_400))).toBe('Pushed through: 6 ticks past it within 8 s');
    expect(bigTradeOutcomeWords(at('pushed', 2, 3))).toBe('Pushed through: 2 ticks past it within 3 ms');
    expect(bigTradeOutcomeWords(at('neither', 4, 60_000))).toBe('Neither within 60 s');
    expect(bigTradeOutcomeWords(trade(1, 0, 5800, 60, 1))).toBeNull();
  });

  it('cards one bubble in two lines: side, size and price, then time, fills, tier and what happened next', () => {
    const card = (t: BigTrade) =>
      bigTradeCard(
        t,
        (p) => p.toFixed(2),
        (ms) => `@${String(ms)}`,
      );
    const sweep: BigTrade = {
      ...trade(1, 5000, 5800.5, 1200, 1),
      prints: 18,
      firstPrice: 5799.75,
      lastPrice: 5801.25,
      durationMs: 1200,
      levels: 7,
      orders: 3,
      tier: 'high',
      outcome: { kind: 'pushed', reachTicks: 30, withinMs: 60_000 },
    };
    expect(card(sweep)).toEqual({
      side: 1,
      headline: ['Buy 1,200 @ 5799.75–5801.25', '7 levels'],
      detail: ['@5000', '18 fills in 1.2 s', '3 orders', 'High tier', 'Pushed through 30 ticks in 60 s'],
    });
    expect(
      card({ ...trade(2, 0, 5800, 40, -1), outcome: { kind: 'absorbed', reachTicks: 1, withinMs: 9_000 } }),
    ).toEqual({
      side: -1,
      headline: ['Sell 40 @ 5800.00'],
      detail: ['@0', '1 fill', 'Absorbed, back 1 tick in 9 s'],
    });
    expect(card({ ...sweep, outcome: { kind: 'neither', reachTicks: 2, withinMs: 60_000 } }).detail.at(-1)).toBe(
      'Neither within 60 s',
    );
    expect(card({ ...sweep, outcome: null }).detail.at(-1), 'nothing while undecided').toBe('High tier');
    expect(card({ ...sweep, tier: null }).detail).not.toContain('High tier');
  });
});
