import type { Bar, BarInput } from './types.ts';

const BLOCK = 256;

export const CHART_MAX_BARS = 50_000;

export interface DataChange {
  kind: 'set' | 'append' | 'update';
  from: number;
}

type Row = [t: number, o: number, h: number, l: number, c: number, v: number, bv: number];

function readBar(b: BarInput): Row {
  if (Array.isArray(b)) {
    const t = b as readonly number[];
    return [t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!, t[6] ?? NaN];
  }
  const o = b as Bar;
  return [o.t, o.o, o.h, o.l, o.c, o.v, o.bv ?? NaN];
}

export class SeriesStore {
  private cap: number;
  private n = 0;
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  buyVolume: Float64Array;
  private blockHigh: Float64Array;
  private blockLow: Float64Array;
  private blockVol: Float64Array;

  constructor(capacity = 1024) {
    this.cap = Math.max(16, capacity);
    this.time = new Float64Array(this.cap);
    this.open = new Float64Array(this.cap);
    this.high = new Float64Array(this.cap);
    this.low = new Float64Array(this.cap);
    this.close = new Float64Array(this.cap);
    this.volume = new Float64Array(this.cap);
    this.buyVolume = new Float64Array(this.cap);
    const blocks = Math.ceil(this.cap / BLOCK);
    this.blockHigh = new Float64Array(blocks).fill(-Infinity);
    this.blockLow = new Float64Array(blocks).fill(Infinity);
    this.blockVol = new Float64Array(blocks);
  }

  get length(): number {
    return this.n;
  }

  get lastTime(): number | null {
    return this.n > 0 ? this.time[this.n - 1]! : null;
  }

  private grow(min: number): void {
    if (min <= this.cap) return;
    let cap = this.cap;
    while (cap < min) cap *= 2;
    const re = (a: Float64Array) => {
      const b = new Float64Array(cap);
      b.set(a.subarray(0, this.n));
      return b;
    };
    this.time = re(this.time);
    this.open = re(this.open);
    this.high = re(this.high);
    this.low = re(this.low);
    this.close = re(this.close);
    this.volume = re(this.volume);
    this.buyVolume = re(this.buyVolume);
    this.cap = cap;
    const blocks = Math.ceil(cap / BLOCK);
    const bh = new Float64Array(blocks).fill(-Infinity);
    const bl = new Float64Array(blocks).fill(Infinity);
    const bv = new Float64Array(blocks);
    bh.set(this.blockHigh);
    bl.set(this.blockLow);
    bv.set(this.blockVol);
    this.blockHigh = bh;
    this.blockLow = bl;
    this.blockVol = bv;
  }

  private write(i: number, [t, o, h, l, c, v, bv]: Row): void {
    this.time[i] = t;
    this.open[i] = o;
    this.high[i] = h;
    this.low[i] = l;
    this.close[i] = c;
    this.volume[i] = v;
    this.buyVolume[i] = bv;
  }

  private rebuildBlock(b: number): void {
    const start = b * BLOCK;
    const end = Math.min(this.n, start + BLOCK);
    let hi = -Infinity;
    let lo = Infinity;
    let vmax = 0;
    for (let i = start; i < end; i++) {
      const h = this.high[i]!;
      const l = this.low[i]!;
      const v = this.volume[i]!;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
      if (v > vmax) vmax = v;
    }
    this.blockHigh[b] = hi;
    this.blockLow[b] = lo;
    this.blockVol[b] = vmax;
  }

  setData(bars: readonly BarInput[]): DataChange {
    this.n = 0;
    this.grow(bars.length);
    let last = -Infinity;
    for (const b of bars) {
      const row = readBar(b);
      const t = row[0];
      if (!Number.isFinite(t)) continue;
      if (t === last && this.n > 0) {
        this.write(this.n - 1, row);
        continue;
      }
      if (t < last) continue;
      this.write(this.n, row);
      this.n++;
      last = t;
    }
    const blocks = Math.ceil(this.n / BLOCK);
    this.blockHigh.fill(-Infinity);
    this.blockLow.fill(Infinity);
    this.blockVol.fill(0);
    for (let b = 0; b < blocks; b++) this.rebuildBlock(b);
    return { kind: 'set', from: 0 };
  }

  copyFrom(other: SeriesStore): DataChange {
    const n = other.length;
    this.n = 0;
    this.grow(n);
    for (const k of ['time', 'open', 'high', 'low', 'close', 'volume', 'buyVolume'] as const) {
      this[k].set(other[k].subarray(0, n));
    }
    this.n = n;
    const blocks = Math.ceil(n / BLOCK);
    this.blockHigh.fill(-Infinity);
    this.blockLow.fill(Infinity);
    this.blockVol.fill(0);
    for (let b = 0; b < blocks; b++) this.rebuildBlock(b);
    return { kind: 'set', from: 0 };
  }

  prepend(bars: readonly BarInput[]): number {
    const first = this.n > 0 ? this.time[0]! : Infinity;
    const rows: Row[] = [];
    let last = -Infinity;
    for (const b of bars) {
      const row = readBar(b);
      const t = row[0];
      if (!Number.isFinite(t) || t >= first) continue;
      if (t === last && rows.length > 0) {
        rows[rows.length - 1] = row;
        continue;
      }
      if (t < last) continue;
      rows.push(row);
      last = t;
    }
    const k = rows.length;
    if (k === 0) return 0;
    const n = this.n;
    this.grow(n + k);
    for (const a of [this.time, this.open, this.high, this.low, this.close, this.volume, this.buyVolume]) {
      a.copyWithin(k, 0, n);
    }
    for (let i = 0; i < k; i++) this.write(i, rows[i]!);
    this.n = n + k;
    this.blockHigh.fill(-Infinity);
    this.blockLow.fill(Infinity);
    this.blockVol.fill(0);
    const blocks = Math.ceil(this.n / BLOCK);
    for (let b = 0; b < blocks; b++) this.rebuildBlock(b);
    return k;
  }

  upsert(bar: BarInput): DataChange | null {
    const row = readBar(bar);
    const t = row[0];
    if (!Number.isFinite(t)) return null;
    const n = this.n;
    if (n === 0 || t > this.time[n - 1]!) {
      this.grow(n + 1);
      this.write(n, row);
      this.n = n + 1;
      this.rebuildBlock(Math.floor(n / BLOCK));
      return { kind: 'append', from: n };
    }
    const i = t === this.time[n - 1]! ? n - 1 : this.indexOfTime(t);
    if (i < 0 || this.time[i] !== t) return null;
    this.write(i, row);
    this.rebuildBlock(Math.floor(i / BLOCK));
    return { kind: 'update', from: i };
  }

  bar(i: number): Bar {
    const bar: Bar = {
      t: this.time[i]!,
      o: this.open[i]!,
      h: this.high[i]!,
      l: this.low[i]!,
      c: this.close[i]!,
      v: this.volume[i]!,
    };
    const bv = this.buyVolume[i]!;
    if (!Number.isNaN(bv)) bar.bv = bv;
    return bar;
  }

  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.n - 1;
    if (hi < 0 || t < this.time[0]!) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.time[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  indexOfTime(t: number): number {
    const i = this.indexAtOrBefore(t);
    return i >= 0 && this.time[i] === t ? i : -1;
  }

  private scan(from: number, to: number, f: (b: number, i0: number, i1: number) => void): void {
    const a = Math.max(0, from);
    const z = Math.min(this.n - 1, to);
    if (z < a) return;
    const ba = Math.floor(a / BLOCK);
    const bz = Math.floor(z / BLOCK);
    for (let b = ba; b <= bz; b++) {
      const s = b * BLOCK;
      const e = s + BLOCK - 1;
      f(b, Math.max(a, s), Math.min(z, e));
    }
  }

  range(from: number, to: number): [number, number] | null {
    let hi = -Infinity;
    let lo = Infinity;
    this.scan(from, to, (b, i0, i1) => {
      if (i0 === b * BLOCK && i1 === b * BLOCK + BLOCK - 1) {
        if (this.blockHigh[b]! > hi) hi = this.blockHigh[b]!;
        if (this.blockLow[b]! < lo) lo = this.blockLow[b]!;
        return;
      }
      for (let i = i0; i <= i1; i++) {
        if (this.high[i]! > hi) hi = this.high[i]!;
        if (this.low[i]! < lo) lo = this.low[i]!;
      }
    });
    return hi >= lo ? [lo, hi] : null;
  }

  maxVolume(from: number, to: number): number {
    let m = 0;
    this.scan(from, to, (b, i0, i1) => {
      if (i0 === b * BLOCK && i1 === b * BLOCK + BLOCK - 1) {
        if (this.blockVol[b]! > m) m = this.blockVol[b]!;
        return;
      }
      for (let i = i0; i <= i1; i++) if (this.volume[i]! > m) m = this.volume[i]!;
    });
    return m;
  }
}
