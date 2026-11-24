import type { DataChange, SeriesStore } from '../store.ts';

export type SeriesColumns = Readonly<Record<string, Float64Array | null>>;

export type SeriesChange =
  { readonly kind: 'all' } | { readonly kind: 'span'; readonly from: number; readonly to: number };

export const ALL_CHANGED: SeriesChange = { kind: 'all' };

function nanFilled(capacity: number): Float64Array {
  return new Float64Array(capacity).fill(Number.NaN);
}

export class SeriesValues {
  private n = 0;
  private times: Float64Array = new Float64Array(0);
  private readonly columns = new Map<string, Float64Array>();

  get length(): number {
    return this.n;
  }

  get firstTime(): number | null {
    return this.n > 0 ? this.times[0]! : null;
  }

  get time(): Float64Array {
    return this.times.subarray(0, this.n);
  }

  column(key: string): Float64Array | null {
    return this.columns.get(key)?.subarray(0, this.n) ?? null;
  }

  keys(): string[] {
    return [...this.columns.keys()];
  }

  firstAtOrAfter(t: number): number {
    return this.search((at) => at < t);
  }

  private firstAfter(t: number): number {
    return this.search((at) => at <= t);
  }

  private search(before: (at: number) => boolean): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (before(this.times[mid]!)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  valueAt(key: string, t: number): number {
    const i = this.firstAtOrAfter(t);
    const col = this.columns.get(key);
    return col && i < this.n && this.times[i] === t ? col[i]! : Number.NaN;
  }

  clear(): void {
    this.n = 0;
    this.columns.clear();
  }

  replaceAll(time: Float64Array, columns: SeriesColumns): void {
    this.clear();
    this.replaceSpan(-Infinity, Infinity, time, columns);
  }

  replaceSpan(from: number, to: number, time: Float64Array, columns: SeriesColumns): void {
    const start = this.firstAtOrAfter(from);
    const end = this.firstAfter(to);
    const k = time.length;
    const n = this.n - (end - start) + k;
    this.reserve(n);
    for (const key of Object.keys(columns)) {
      if (!this.columns.has(key)) this.columns.set(key, nanFilled(this.times.length));
    }
    const move = end !== start + k && end < this.n;
    if (move) this.times.copyWithin(start + k, end, this.n);
    this.times.set(time, start);
    for (const [key, col] of this.columns) {
      if (move) col.copyWithin(start + k, end, this.n);
      const given = columns[key];
      if (given) col.set(given, start);
      else col.fill(Number.NaN, start, start + k);
    }
    this.n = n;
  }

  private reserve(n: number): void {
    const capacity = this.times.length;
    if (n <= capacity) return;
    const next = Math.max(n, capacity * 2, 64);
    const grow = (a: Float64Array, fill: boolean) => {
      const b = fill ? nanFilled(next) : new Float64Array(next);
      b.set(a.subarray(0, this.n));
      return b;
    };
    this.times = grow(this.times, false);
    for (const [key, col] of this.columns) this.columns.set(key, grow(col, true));
  }
}

export class AlignedColumns {
  readonly rows: Record<string, Float64Array> = {};
  private readonly keys: readonly string[];
  private source: SeriesValues;
  private store: SeriesStore | null = null;
  private n = 0;
  private capacity = 0;

  constructor(keys: readonly string[], values: SeriesValues = new SeriesValues()) {
    this.keys = keys;
    this.source = values;
    for (const key of keys) this.rows[key] = new Float64Array(0);
  }

  get length(): number {
    return this.n;
  }

  get values(): SeriesValues {
    return this.source;
  }

  setValues(values: SeriesValues): void {
    this.source = values;
    this.align(0, this.n);
  }

  onRows(change: DataChange, store: SeriesStore): void {
    this.store = store;
    this.reserve(store.length);
    const from = change.kind === 'set' ? 0 : Math.min(change.from, this.n);
    this.n = store.length;
    this.align(from, this.n);
  }

  onValues(change: SeriesChange): void {
    const store = this.store;
    if (!store) return;
    if (change.kind === 'all') {
      this.align(0, this.n);
      return;
    }
    const before = store.indexAtOrBefore(change.from);
    const first = before >= 0 && store.time[before] === change.from ? before : before + 1;
    this.align(first, Math.min(this.n, store.indexAtOrBefore(change.to) + 1));
  }

  private reserve(n: number): void {
    if (n <= this.capacity) return;
    let capacity = Math.max(64, this.capacity);
    while (capacity < n) capacity *= 2;
    for (const key of this.keys) {
      const next = nanFilled(capacity);
      next.set(this.rows[key]!.subarray(0, this.n));
      this.rows[key] = next;
    }
    this.capacity = capacity;
  }

  private align(from: number, to: number): void {
    const store = this.store;
    if (!store || to <= from) return;
    const barTime = store.time;
    const time = this.source.time;
    const pairs = this.keys.map((key) => [this.rows[key]!, this.source.column(key)] as const);
    let j = this.source.firstAtOrAfter(barTime[from]!);
    for (let i = from; i < to; i++) {
      const t = barTime[i]!;
      while (j < time.length && time[j]! < t) j++;
      const hit = j < time.length && time[j] === t;
      for (const [row, column] of pairs) row[i] = hit && column ? column[j]! : Number.NaN;
    }
  }
}
