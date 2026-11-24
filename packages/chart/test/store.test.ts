import { describe, expect, it } from 'vitest';
import { SeriesStore } from '../src/index.ts';
import { equityBars } from './fixtures.ts';

describe('SeriesStore', () => {
  it('stores bars in typed arrays and accepts tuples', () => {
    const s = new SeriesStore(4);
    s.setData([[1000, 1, 2, 0.5, 1.5, 10], { t: 2000, o: 1.5, h: 3, l: 1, c: 2.5, v: 20 }]);
    expect(s.length).toBe(2);
    expect(s.time).toBeInstanceOf(Float64Array);
    expect(s.bar(1)).toEqual({ t: 2000, o: 1.5, h: 3, l: 1, c: 2.5, v: 20 });
  });

  it('keeps aggressive buy volume when the feed knows it', () => {
    const s = new SeriesStore(4);
    s.setData([[1000, 1, 2, 0.5, 1.5, 10, 6], { t: 2000, o: 1.5, h: 3, l: 1, c: 2.5, v: 20 }]);
    expect(s.bar(0)).toEqual({ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, bv: 6 });
    expect(s.bar(1).bv).toBeUndefined();
    expect(Number.isNaN(s.buyVolume[1])).toBe(true);
    s.upsert({ t: 2000, o: 1.5, h: 3, l: 1, c: 2.6, v: 21, bv: 9 });
    expect(s.bar(1).bv).toBe(9);
    for (let i = 3; i < 40; i++) s.upsert([i * 1000, 1, 1, 1, 1, 2, 1]);
    expect(s.bar(0).bv).toBe(6);
  });

  it('drops out-of-order bars and keeps the last duplicate', () => {
    const s = new SeriesStore();
    s.setData([
      [1000, 1, 1, 1, 1, 1],
      [3000, 3, 3, 3, 3, 3],
      [2000, 2, 2, 2, 2, 2],
      [3000, 4, 4, 4, 4, 4],
    ]);
    expect(Array.from(s.time.subarray(0, s.length))).toEqual([1000, 3000]);
    expect(s.close[1]).toBe(4);
  });

  it('upsert updates the forming bar, appends newer bars and grows capacity', () => {
    const s = new SeriesStore(16);
    s.setData([[0, 1, 1, 1, 1, 1]]);
    expect(s.upsert([0, 1, 5, 0.5, 4, 2])).toEqual({ kind: 'update', from: 0 });
    expect(s.high[0]).toBe(5);
    for (let i = 1; i <= 100; i++) expect(s.upsert([i * 60_000, i, i + 1, i - 1, i, 1])?.kind).toBe('append');
    expect(s.length).toBe(101);
    expect(s.upsert([-5, 0, 0, 0, 0, 0])).toBeNull();
    expect(s.upsert([30 * 60_000, 9, 9, 9, 9, 9])).toEqual({ kind: 'update', from: 30 });
  });

  it('range/maxVolume match a brute-force scan over arbitrary windows (block index)', () => {
    const bars = equityBars(30);
    const s = new SeriesStore();
    s.setData(bars);
    const brute = (a: number, b: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      let v = 0;
      for (let i = a; i <= b; i++) {
        lo = Math.min(lo, bars[i]!.l);
        hi = Math.max(hi, bars[i]!.h);
        v = Math.max(v, bars[i]!.v);
      }
      return { lo, hi, v };
    };
    for (const [a, b] of [
      [0, 0],
      [0, bars.length - 1],
      [10, 700],
      [255, 257],
      [512, 1023],
      [1000, 2339],
    ] as const) {
      const exp = brute(a, b);
      expect(s.range(a, b)).toEqual([exp.lo, exp.hi]);
      expect(s.maxVolume(a, b)).toBe(exp.v);
    }
    s.upsert({ ...bars[300]!, h: 9999 });
    expect(s.range(256, 511)?.[1]).toBe(9999);
  });

  it('prepends older bars in front, shifting indices and keeping the block index right', () => {
    const bars = equityBars(30);
    const s = new SeriesStore(64);
    s.setData(bars.slice(1_000));
    const older = [
      ...bars.slice(0, 600),
      bars[599]!,
      bars[10]!,
      ...bars.slice(600, 1_000),
      ...bars.slice(1_000, 1_010),
    ];
    expect(s.prepend(older)).toBe(1_000);
    expect(s.length).toBe(bars.length);
    for (const i of [0, 599, 600, 999, 1_000, bars.length - 1]) expect(s.bar(i)).toEqual(bars[i]);
    const hi = Math.max(...bars.slice(200, 1_500).map((b) => b.h));
    const lo = Math.min(...bars.slice(200, 1_500).map((b) => b.l));
    expect(s.range(200, 1_499)).toEqual([lo, hi]);
    expect(s.indexOfTime(bars[1_000]!.t)).toBe(1_000);
    expect(s.prepend(bars.slice(5, 10))).toBe(0);
    expect(s.length).toBe(bars.length);
    const e = new SeriesStore();
    expect(e.prepend(bars.slice(0, 3))).toBe(3);
    expect(e.bar(2)).toEqual(bars[2]);
  });

  it('copies another store as it holds its bars, block index and buy volume included', () => {
    const held = new SeriesStore(4);
    const bars = equityBars(9);
    const n = bars.length;
    const last = bars[n - 1]!;
    held.setData(bars);
    held.upsert({ ...last, t: last.t + 60_000, bv: 3 });
    const s = new SeriesStore(8);
    s.setData([[1, 1, 1, 1, 1, 1]]);
    expect(s.copyFrom(held)).toEqual({ kind: 'set', from: 0 });
    expect(s.length).toBe(n + 1);
    for (const i of [0, Math.floor(n / 2), n - 1, n]) expect(s.bar(i)).toEqual(held.bar(i));
    expect(s.range(10, n - 10)).toEqual(held.range(10, n - 10));
    expect(s.maxVolume(0, n)).toBe(held.maxVolume(0, n));
    held.upsert({ ...last, t: last.t + 120_000 });
    expect(s.length).toBe(n + 1);
  });

  it('binary searches by time', () => {
    const s = new SeriesStore();
    s.setData([
      [100, 1, 1, 1, 1, 1],
      [200, 1, 1, 1, 1, 1],
      [400, 1, 1, 1, 1, 1],
    ]);
    expect(s.indexAtOrBefore(50)).toBe(-1);
    expect(s.indexAtOrBefore(250)).toBe(1);
    expect(s.indexAtOrBefore(400)).toBe(2);
    expect(s.indexOfTime(200)).toBe(1);
    expect(s.indexOfTime(300)).toBe(-1);
  });
});
