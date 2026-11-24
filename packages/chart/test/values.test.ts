import { describe, expect, it } from 'vitest';
import { IndicatorLayer, SeriesValues, type IndicatorDef } from '../src/index.ts';
import { headless } from './fixtures.ts';

const f64 = (values: readonly number[]) => Float64Array.from(values);
const N = Number.NaN;

function held(v: SeriesValues, key: string): [number, number][] {
  const col = v.column(key);
  return [...v.time].map((t, i) => [t, col ? col[i]! : N]);
}

function series(times: readonly number[], ma: readonly number[]): SeriesValues {
  const v = new SeriesValues();
  v.replaceAll(f64(times), { ma: f64(ma) });
  return v;
}

describe('series values', () => {
  it('holds a snapshot by bar time, and a later snapshot replaces every value and column', () => {
    const v = new SeriesValues();
    v.replaceAll(f64([10, 20, 30]), { ma: f64([1, 2, 3]), signal: null });
    expect(held(v, 'ma')).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(v.valueAt('signal', 20)).toBeNaN();
    expect(v.valueAt('ma', 25)).toBeNaN();
    v.replaceAll(f64([40]), { ma: f64([4]) });
    expect(held(v, 'ma')).toEqual([[40, 4]]);
    expect(v.column('signal')).toBeNull();
  });

  it('replaces a span inside what it holds, the forming bar as one row', () => {
    const v = series([10, 20, 30, 40], [1, 2, 3, 4]);
    v.replaceSpan(40, 40, f64([40]), { ma: f64([4.5]) });
    expect(held(v, 'ma').at(-1)).toEqual([40, 4.5]);
    v.replaceSpan(20, 30, f64([20, 30]), { ma: f64([7, 8]) });
    expect(held(v, 'ma')).toEqual([
      [10, 1],
      [20, 7],
      [30, 8],
      [40, 4.5],
    ]);
  });

  it('takes a span before what it holds in front of it, and one after it behind', () => {
    const v = series([30, 40], [3, 4]);
    v.replaceSpan(5, 20, f64([10, 20]), { ma: f64([1, 2]) });
    v.replaceSpan(50, 50, f64([50]), { ma: f64([5]) });
    expect(held(v, 'ma')).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
      [40, 4],
      [50, 5],
    ]);
  });

  it('drops a held bar of the span that the update no longer has', () => {
    const v = series([10, 20, 30, 40], [1, 2, 3, 4]);
    v.replaceSpan(20, 30, f64([30]), { ma: f64([9]) });
    expect(held(v, 'ma')).toEqual([
      [10, 1],
      [30, 9],
      [40, 4],
    ]);
    v.replaceSpan(0, 100, f64([]), {});
    expect(v.length).toBe(0);
  });

  it('reads a null column as no values, and a column first sent in a span as none elsewhere', () => {
    const v = series([10, 20, 30], [1, 2, 3]);
    v.replaceSpan(20, 20, f64([20]), { ma: null, upper: f64([6]) });
    expect(held(v, 'ma')).toEqual([
      [10, 1],
      [20, N],
      [30, 3],
    ]);
    expect(held(v, 'upper')).toEqual([
      [10, N],
      [20, 6],
      [30, N],
    ]);
  });

  it('grows past what it first held without losing a value', () => {
    const v = new SeriesValues();
    for (let t = 0; t < 500; t++) v.replaceSpan(t, t, f64([t]), { ma: f64([t * 2]) });
    expect(v.length).toBe(500);
    expect(v.valueAt('ma', 0)).toBe(0);
    expect(v.valueAt('ma', 499)).toBe(998);
    v.replaceSpan(-10, -1, f64([-5]), { ma: f64([-10]) });
    expect(v.valueAt('ma', -5)).toBe(-10);
    expect(v.valueAt('ma', 499)).toBe(998);
    expect(v.length).toBe(501);
  });
});

const MIN = 60_000;
const at = (k: number) => Date.UTC(2026, 9, 2, 13, 30) + k * MIN;
const barsAt = (ks: readonly number[]) => ks.map((k) => ({ t: at(k), o: 100, h: 101, l: 99, c: 100 + k, v: 10 }));

const SMA: IndicatorDef = {
  kind: 'sma',
  short: 'SMA',
  placement: 'overlay',
  plots: [{ key: 'ma', label: 'SMA', kind: 'line' }],
  fills: [],
  sessionReset: false,
  format: 'price',
};

function smaOn(values: SeriesValues) {
  const chart = headless({ volumePane: 0 });
  const layer = new IndicatorLayer({
    id: 'sma',
    def: SMA,
    inputs: { length: 20 },
    style: { plots: { ma: { color: '#aab6bb', width: 1, line: 'solid', opacity: 1, visible: true } }, fills: {} },
    label: 'SMA 20',
    values,
  });
  chart.addLayer(layer);
  const rows = () => Array.from({ length: layer.length }, (_, i) => layer.valueAt('ma', i));
  return { chart, layer, rows };
}

const timesAt = (ks: readonly number[]) => f64(ks.map(at));

describe('an indicator layer draws the runtime values on the bars they belong to', () => {
  it('reads each bar the value of its own time, and nothing where the values have none', () => {
    const values = new SeriesValues();
    values.replaceAll(timesAt([0, 1, 2, 2.5, 5, 6]), { ma: f64([10, 11, 12, 99, 15, 16]) });
    const { chart, rows } = smaOn(values);
    chart.setData('main', barsAt([0, 1, 2, 3, 4, 5, 6]));
    expect(rows()).toEqual([10, 11, 12, N, N, 15, 16]);
    chart.destroy();
  });

  it('lines the values up again after older bars are read back in front, and as the values reach them', () => {
    const values = new SeriesValues();
    values.replaceAll(timesAt([1, 2, 3, 4, 5]), { ma: f64([11, 12, 13, 14, 15]) });
    const { chart, layer, rows } = smaOn(values);
    chart.setData('main', barsAt([3, 4, 5]));
    expect(rows()).toEqual([13, 14, 15]);
    chart.prepend('main', barsAt([0, 1, 2]));
    expect(rows()).toEqual([N, 11, 12, 13, 14, 15]);
    values.replaceSpan(at(0), at(0), timesAt([0]), { ma: f64([10]) });
    layer.valuesChanged({ kind: 'span', from: at(0), to: at(0) });
    expect(rows()).toEqual([10, 11, 12, 13, 14, 15]);
    chart.destroy();
  });

  it('realigns exactly the rows of the span it is told changed, a live tick one row', () => {
    const values = new SeriesValues();
    values.replaceAll(timesAt([0, 1, 2, 3]), { ma: f64([10, 11, 12, 13]) });
    const { chart, layer, rows } = smaOn(values);
    chart.setData('main', barsAt([0, 1, 2, 3]));
    values.replaceSpan(at(2), at(3), timesAt([2, 3]), { ma: f64([22, 23]) });
    layer.valuesChanged({ kind: 'span', from: at(3), to: at(3) });
    expect(rows()).toEqual([10, 11, 12, 23]);
    layer.valuesChanged({ kind: 'span', from: at(0), to: at(2) });
    expect(rows()).toEqual([10, 11, 22, 23]);
    chart.update('main', barsAt([4])[0]!);
    expect(rows()).toEqual([10, 11, 22, 23, N]);
    values.replaceSpan(at(4), at(4), timesAt([4]), { ma: f64([24]) });
    layer.valuesChanged({ kind: 'span', from: at(4), to: at(4) });
    expect(rows()).toEqual([10, 11, 22, 23, 24]);
    chart.destroy();
  });

  it('draws another series of values whole when it is given one', () => {
    const first = new SeriesValues();
    first.replaceAll(timesAt([0, 1]), { ma: f64([10, 11]) });
    const { chart, layer, rows } = smaOn(first);
    chart.setData('main', barsAt([0, 1]));
    const next = new SeriesValues();
    next.replaceAll(timesAt([1]), { ma: f64([21]) });
    layer.setValues(next);
    expect(rows()).toEqual([N, 21]);
    chart.destroy();
  });
});
