import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { TESSERA_THEME } from '../src/theme.ts';
import {
  addTpoPrints,
  MarketProfileLayer,
  PriceFormatter,
  TickGrid,
  tpoLetter,
  tpoProfile,
  type Bar,
  type MarketProfileOptions,
  type PlotStyle,
  type SessionProfileData,
  type TpoData,
} from '../src/index.ts';
import { headless, rng } from './fixtures.ts';

const TICK = 0.25;
const GRID = new TickGrid(TICK);
const FMT = new PriceFormatter({ precision: 2, minMove: TICK });
const T0 = Date.UTC(2026, 9, 6, 13, 30);
const MIN = 60_000;
const HALF_HOUR = 30 * MIN;

const style = (color: string): PlotStyle => ({
  color,
  downColor: null,
  width: 1,
  line: 'solid',
  opacity: 1,
  visible: true,
});
const STYLE = { poc: style('#dcebef'), vah: style('#6f7c82'), val: style('#6f7c82') };

function bars(n: number, seed = 3): Bar[] {
  const r = rng(seed);
  let p = 5800;
  return Array.from({ length: n }, (_, i) => {
    const lo = p - Math.floor(r() * 6) * TICK;
    const hi = p + Math.floor(r() * 6) * TICK;
    const c = lo + Math.floor(r() * ((hi - lo) / TICK + 1)) * TICK;
    const bar = { t: T0 + i * MIN, o: p, h: hi, l: lo, c, v: 100 };
    p = c;
    return bar;
  });
}

function tpoOf(bs: readonly Bar[], from: number): TpoData {
  const brackets = new Map<number, { start: number; letter: number; lowTick: number; highTick: number }>();
  for (const b of bs) {
    const letter = Math.floor((b.t - from) / HALF_HOUR);
    const held = brackets.get(letter);
    const lowTick = GRID.toTick(b.l);
    const highTick = GRID.toTick(b.h);
    brackets.set(letter, {
      start: from + letter * HALF_HOUR,
      letter,
      lowTick: Math.min(held?.lowTick ?? lowTick, lowTick),
      highTick: Math.max(held?.highTick ?? highTick, highTick),
    });
  }
  const ib = bs.filter((b) => b.t < from + 2 * HALF_HOUR);
  return {
    minutes: 30,
    brackets: [...brackets.values()],
    ibFrom: from,
    ibLowTick: Math.min(...ib.map((b) => GRID.toTick(b.l))),
    ibHighTick: Math.max(...ib.map((b) => GRID.toTick(b.h))),
  };
}

function session(bs: readonly Bar[]): SessionProfileData {
  return {
    from: T0,
    to: T0 + bs.length * MIN,
    label: 'Tue',
    rowTicks: 1,
    lowTick: 0,
    rows: 0,
    volume: new Float64Array(0),
    buy: new Float64Array(0),
    sell: new Float64Array(0),
    tpo: tpoOf(bs, T0),
  };
}

function drawn(bs: Bar[], options: Partial<MarketProfileOptions> = {}) {
  const texts: string[] = [];
  const chart = headless({
    timeframeMs: MIN,
    priceFormat: { precision: 2, minMove: TICK },
    sessions: { mode: 'continuous', timezone: 'UTC', dayStartMinutes: 0 },
    legend: false,
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
  chart.setData('main', bs);
  const layer = new MarketProfileLayer({ id: 'tpo', grid: GRID, style: STYLE, options });
  const s = session(bs);
  const asked: unknown[][] = [];
  layer.setSource({
    periods: (...args) => {
      asked.push(args);
      return [s];
    },
    composite: () => null,
    span: () => null,
  });
  chart.addLayer(layer);
  chart.render();
  const letters = texts.filter((t) => /^[A-Za-z]$/.test(t));
  return { chart, layer, letters, asked, s };
}

describe('TPO letters', () => {
  it('run A to Z, then a to z, and around again', () => {
    expect([0, 1, 25, 26, 51, 52].map(tpoLetter)).toEqual(['A', 'B', 'Z', 'a', 'z', 'A']);
  });
});

describe('a TPO profile', () => {
  const at = (p: number) => GRID.toTick(p);
  const tpo: TpoData = {
    minutes: 30,
    brackets: [
      { start: T0, letter: 0, lowTick: at(100), highTick: at(100.75) },
      { start: T0 + HALF_HOUR, letter: 1, lowTick: at(100.25), highTick: at(101.5) },
      { start: T0 + 2 * HALF_HOUR, letter: 2, lowTick: at(100.25), highTick: at(100.5) },
      { start: T0 + 3 * HALF_HOUR, letter: 3, lowTick: at(102), highTick: at(102) },
    ],
    ibFrom: T0,
    ibLowTick: at(100),
    ibHighTick: at(101.5),
  };

  it('counts the brackets at each price and finds the runtime’s POC and value area', () => {
    const p = tpoProfile(tpo, 1, 1, 0.7, GRID);
    expect(p.poc).toBe(100.5);
    expect(p.val).toBeLessThanOrEqual(100.25);
    expect(p.vah).toBeGreaterThanOrEqual(100.75);
    expect(p.letters[at(100.25) - p.lowTick]).toEqual([0, 1, 2]);
    expect(p.letters[at(101.75) - p.lowTick]).toEqual([]);
    expect(p.maxCount).toBe(3);
    expect([p.ibLow, p.ibHigh]).toEqual([100, 101.5]);
  });

  it('stacks a bracket once per row however many of its ticks the row holds', () => {
    const p = tpoProfile(tpo, 1, 4, 0.7, GRID);
    expect(p.rowTicks).toBe(4);
    expect(p.letters[0]).toEqual([0, 1, 2]);
    expect(p.poc).toBe(100.5);
  });

  it('measures its POC and value area on the rows the runtime measured, coarser ones drawn on the same grid', () => {
    const p = tpoProfile(tpo, 2, 3, 0.7, GRID);
    expect(p.rowTicks).toBe(4);
    expect(p.poc).toBe(100.5);
    expect(p.val).toBeGreaterThanOrEqual(100);
    expect(p.vah).toBeLessThanOrEqual(102);
    expect((p.vah - p.val) / TICK + 1).toBeGreaterThanOrEqual(4);
  });

  it('grows the newest bracket, opens the next on its letter, and widens the first hour live', () => {
    const live = addTpoPrints(tpo, T0, [
      [at(102.5), T0 + 3 * HALF_HOUR + MIN],
      [at(99), T0 + 5 * HALF_HOUR + 5 * MIN],
    ]);
    expect(live.brackets.at(-2)).toMatchObject({ letter: 3, lowTick: at(102), highTick: at(102.5) });
    expect(live.brackets.at(-1)).toMatchObject({ letter: 5, start: T0 + 5 * HALF_HOUR, lowTick: at(99) });
    expect(live.ibLowTick).toBe(at(100));
    const early = addTpoPrints({ ...tpo, brackets: [] }, T0, [[at(98), T0 + 10 * MIN]]);
    expect(early.brackets).toEqual([{ start: T0, letter: 0, lowTick: at(98), highTick: at(98) }]);
    expect(early.ibLowTick).toBe(at(98));
  });
});

describe('market profile layer', () => {
  it('asks the profile feed for its period, hours and TPO size', () => {
    const { chart, asked } = drawn(bars(120), { period: 'week', hours: 'rth', tpo: 15 });
    expect(asked).toContainEqual(['week', 'rth', 15]);
    chart.destroy();
  });

  it('writes a letter per bracket at every price it traded, and reports the TPO POC', () => {
    const bs = bars(120);
    const { chart, layer, letters, s } = drawn(bs);
    const p = tpoProfile(s.tpo!, 1, 1, 0.7, GRID);
    expect(new Set(letters)).toEqual(new Set(['A', 'B', 'C', 'D']));
    expect(letters.length).toBeGreaterThanOrEqual(4);
    expect(layer.rendered()).toEqual([expect.objectContaining({ label: 'Tue', poc: p.poc, vah: p.vah, val: p.val })]);
    expect(layer.legendValues(0, FMT, TESSERA_THEME)).toEqual([
      { text: `POC ${FMT.grouped(p.poc)}`, color: STYLE.poc.color },
    ]);
    chart.destroy();
  });

  it('draws blocks when asked, and falls back to blocks where letters cannot be read', () => {
    const bs = bars(120);
    const blocks = drawn(bs, { style: 'blocks' });
    expect(blocks.letters).toEqual([]);
    expect(blocks.layer.rendered()).toHaveLength(1);
    blocks.chart.destroy();
    const wide = bars(120).map((b, i) => ({ ...b, h: b.h + (i === 60 ? 400 : 0) }));
    const cramped = drawn(wide, { rowTicks: 1 });
    expect(cramped.letters).toEqual([]);
    expect(cramped.layer.rendered()).toHaveLength(1);
    cramped.chart.destroy();
  });

  it('names its profile for the analyst under the pointer', () => {
    const bs = bars(120);
    const { chart, layer, s } = drawn(bs);
    const p = tpoProfile(s.tpo!, 1, 1, 0.7, GRID);
    const c = chart.coords();
    const target = layer.askTarget(c.xOfIndex(bs.length - 1), c.yOfPrice(p.poc));
    expect(target).toMatchObject({ kind: 'profile', label: 'the market profile', from: s.from });
    expect(target?.detail).toContain(`TPO POC ${p.poc.toFixed(2)}`);
    chart.destroy();
  });
});
