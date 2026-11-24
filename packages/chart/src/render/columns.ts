import type { Ctx2D, TimeView } from '../layers/types.ts';
import { snap } from './draw.ts';

const COLUMN_BAR_DEVICE_PX = 1.5;

export class PixelColumns {
  count = 0;
  dpr = 1;
  left = new Float64Array(256);
  first = new Int32Array(256);
  last = new Int32Array(256);

  measure(time: TimeView, dpr: number): this | null {
    if (time.to < time.from || time.barSpacing * dpr >= COLUMN_BAR_DEVICE_PX) return null;
    this.dpr = dpr;
    this.count = 0;
    let col = Number.NaN;
    for (let i = time.from; i <= time.to; i++) {
      const c = Math.floor(time.xOfIndex(i) * dpr);
      if (c !== col) {
        col = c;
        if (this.count === this.left.length) this.grow();
        this.left[this.count] = c / dpr;
        this.first[this.count] = i;
        this.count++;
      }
      this.last[this.count - 1] = i;
    }
    return this;
  }

  private grow(): void {
    const n = this.left.length * 2;
    const left = new Float64Array(n);
    const first = new Int32Array(n);
    const last = new Int32Array(n);
    left.set(this.left);
    first.set(this.first);
    last.set(this.last);
    this.left = left;
    this.first = first;
    this.last = last;
  }
}

export interface ColumnView {
  readonly time: TimeView;
  readonly dpr: number;
  readonly columns: PixelColumns | null;
}

class LineRun {
  pen = false;
  private a = -1;
  private lo = -1;
  private hi = -1;
  private z = -1;
  private loV = 0;
  private hiV = 0;

  constructor(
    private readonly value: (i: number) => number,
    private readonly point: (i: number, v: number, start: boolean) => void,
  ) {}

  get open(): boolean {
    return this.a >= 0;
  }

  add(i: number, v: number): void {
    if (this.a < 0) {
      this.a = this.lo = this.hi = i;
      this.loV = this.hiV = v;
    } else if (v < this.loV) {
      this.lo = i;
      this.loV = v;
    } else if (v > this.hiV) {
      this.hi = i;
      this.hiV = v;
    }
    this.z = i;
  }

  flush(): void {
    const { a, lo, hi, z } = this;
    if (a < 0) return;
    const m = Math.min(lo, hi);
    const n = Math.max(lo, hi);
    this.point(a, this.value(a), !this.pen);
    this.pen = true;
    if (m !== a) this.point(m, m === lo ? this.loV : this.hiV, false);
    if (n !== m && n !== a) this.point(n, n === lo ? this.loV : this.hiV, false);
    if (z !== n && z !== a) this.point(z, this.value(z), false);
    this.a = -1;
  }
}

export function traceSeries(
  rc: ColumnView,
  to: number,
  value: (i: number) => number,
  breakBefore: ((i: number) => boolean) | null,
  point: (i: number, v: number, start: boolean) => void,
  penWidth = 0,
): void {
  const { time, columns } = rc;
  if (!columns) {
    let pen = false;
    for (let i = time.from; i <= to; i++) {
      const v = value(i);
      if (Number.isNaN(v)) {
        pen = false;
        continue;
      }
      if (pen && breakBefore?.(i)) pen = false;
      point(i, v, !pen);
      pen = true;
    }
    return;
  }
  const run = new LineRun(value, point);
  const span = Math.max(1, Math.round(penWidth * columns.dpr));
  const group = (k: number) => Math.floor(Math.round(columns.left[k]! * columns.dpr) / span);
  for (let k = 0; k < columns.count; k++) {
    const start = columns.first[k]!;
    if (start > to) break;
    if (span > 1) while (k + 1 < columns.count && columns.first[k + 1]! <= to && group(k + 1) === group(k)) k++;
    const end = Math.min(columns.last[k]!, to);
    for (let i = start; i <= end; i++) {
      const v = value(i);
      if (Number.isNaN(v)) {
        run.flush();
        run.pen = false;
        continue;
      }
      if ((run.pen || run.open) && breakBefore?.(i)) {
        run.flush();
        run.pen = false;
      }
      run.add(i, v);
    }
    run.flush();
  }
}

export function eachBar(
  rc: ColumnView,
  to: number,
  value: (i: number) => number,
  bar: (i: number, x: number) => void,
): void {
  const { time, columns, dpr } = rc;
  if (!columns) {
    for (let i = time.from; i <= to; i++) if (!Number.isNaN(value(i))) bar(i, snap(time.xOfIndex(i), dpr));
    return;
  }
  const half = 0.5 / dpr;
  for (let k = 0; k < columns.count; k++) {
    const start = columns.first[k]!;
    if (start > to) break;
    const end = Math.min(columns.last[k]!, to);
    let up = -1;
    let down = -1;
    let upV = 0;
    let downV = 0;
    for (let i = start; i <= end; i++) {
      const v = value(i);
      if (v >= 0 && (up < 0 || v > upV)) {
        up = i;
        upV = v;
      } else if (v < 0 && (down < 0 || v < downV)) {
        down = i;
        downV = v;
      }
    }
    const x = columns.left[k]! + half;
    if (up >= 0) bar(up, x);
    if (down >= 0) bar(down, x);
  }
}

export interface ColumnRange {
  left: number;
  lo: number;
  hi: number;
  first: number;
  last: number;
}

export function eachColumnRange(
  columns: PixelColumns,
  to: number,
  low: ArrayLike<number>,
  high: ArrayLike<number>,
  breakBefore: ((i: number) => boolean) | null,
  range: (r: Readonly<ColumnRange>) => void,
): void {
  const r: ColumnRange = { left: 0, lo: 0, hi: 0, first: -1, last: -1 };
  for (let k = 0; k < columns.count; k++) {
    const start = columns.first[k]!;
    if (start > to) break;
    const end = Math.min(columns.last[k]!, to);
    r.left = columns.left[k]!;
    r.first = -1;
    for (let i = start; i <= end; i++) {
      const l = low[i]!;
      const h = high[i]!;
      if (Number.isNaN(l) || Number.isNaN(h)) continue;
      if (r.first >= 0 && breakBefore?.(i)) {
        range(r);
        r.first = -1;
      }
      if (r.first < 0) {
        r.first = i;
        r.lo = l;
        r.hi = h;
      } else {
        if (l < r.lo) r.lo = l;
        if (h > r.hi) r.hi = h;
      }
      r.last = i;
    }
    if (r.first >= 0) range(r);
  }
}

export type RectFill = 'one path' | 'one by one';

// Skia rasterises thousands of pixel-aligned rects as one path several times
// slower than as one fillRect each.
export class TwoToneRects {
  private readonly rects = [new Float64Array(1024), new Float64Array(1024)];
  private readonly count = [0, 0];

  readonly add = (tone: 0 | 1, x: number, y: number, w: number, h: number): void => {
    let r = this.rects[tone]!;
    const n = this.count[tone]!;
    if (n + 4 > r.length) {
      const grown = new Float64Array(r.length * 2);
      grown.set(r);
      this.rects[tone] = r = grown;
    }
    r[n] = x;
    r[n + 1] = y;
    r[n + 2] = w;
    r[n + 3] = h;
    this.count[tone] = n + 4;
  };

  fill(ctx: Ctx2D, styles: readonly [string, string], how: RectFill): void {
    for (const tone of [0, 1] as const) {
      const r = this.rects[tone]!;
      const n = this.count[tone]!;
      this.count[tone] = 0;
      if (n === 0) continue;
      ctx.fillStyle = styles[tone];
      if (how === 'one by one') {
        for (let k = 0; k < n; k += 4) ctx.fillRect(r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!);
        continue;
      }
      ctx.beginPath();
      for (let k = 0; k < n; k += 4) ctx.rect(r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!);
      ctx.fill();
    }
  }
}
