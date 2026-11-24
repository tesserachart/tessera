import type { TickGrid } from './ticks.ts';

export const BOOK_STALE_MS = 2000;

export type BookLevelInput =
  readonly [price: number, size: number] | readonly [price: number, size: number, orders: number] | readonly number[];

export interface DepthMessage {
  seq: number;
  kind: 'snapshot' | 'delta' | 'heartbeat';
  levels: number;
  bids: readonly BookLevelInput[];
  asks: readonly BookLevelInput[];
}

export type BookApply = 'applied' | 'alive' | 'stale' | 'gap';

const ORDERS_UNCOUNTED = -1;

export class BookSide {
  readonly side: 'bid' | 'ask';
  ticks: Int32Array;
  sizes: Float64Array;
  orders: Int32Array;
  length = 0;

  constructor(side: 'bid' | 'ask', capacity = 64) {
    this.side = side;
    this.ticks = new Int32Array(capacity);
    this.sizes = new Float64Array(capacity);
    this.orders = new Int32Array(capacity);
  }

  clear(): void {
    this.length = 0;
  }

  private search(tick: number): number {
    let lo = 0;
    let hi = this.length;
    const t = this.ticks;
    if (this.side === 'bid') {
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (t[mid]! > tick) lo = mid + 1;
        else hi = mid;
      }
    } else {
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (t[mid]! < tick) lo = mid + 1;
        else hi = mid;
      }
    }
    return lo;
  }

  indexOf(tick: number): number {
    const i = this.search(tick);
    return i < this.length && this.ticks[i] === tick ? i : -1;
  }

  sizeAt(tick: number): number {
    const i = this.indexOf(tick);
    return i < 0 ? 0 : this.sizes[i]!;
  }

  sumRange(low: number, high: number): number {
    let total = 0;
    let i = this.search(this.side === 'bid' ? high : low);
    for (; i < this.length; i++) {
      const t = this.ticks[i]!;
      if (t < low || t > high) break;
      total += this.sizes[i]!;
    }
    return total;
  }

  set(tick: number, size: number, orders: number): void {
    const i = this.search(tick);
    const hit = i < this.length && this.ticks[i] === tick;
    if (size > 0) {
      if (hit) {
        this.sizes[i] = size;
        this.orders[i] = orders;
        return;
      }
      if (this.length === this.ticks.length) this.grow();
      this.ticks.copyWithin(i + 1, i, this.length);
      this.sizes.copyWithin(i + 1, i, this.length);
      this.orders.copyWithin(i + 1, i, this.length);
      this.ticks[i] = tick;
      this.sizes[i] = size;
      this.orders[i] = orders;
      this.length++;
    } else if (hit) {
      this.ticks.copyWithin(i, i + 1, this.length);
      this.sizes.copyWithin(i, i + 1, this.length);
      this.orders.copyWithin(i, i + 1, this.length);
      this.length--;
    }
  }

  push(tick: number, size: number, orders: number): void {
    if (size <= 0) return;
    if (this.length === this.ticks.length) this.grow();
    this.ticks[this.length] = tick;
    this.sizes[this.length] = size;
    this.orders[this.length] = orders;
    this.length++;
  }

  truncate(n: number): void {
    if (this.length > n) this.length = Math.max(0, n);
  }

  private grow(): void {
    const n = this.ticks.length * 2;
    const ticks = new Int32Array(n);
    const sizes = new Float64Array(n);
    const orders = new Int32Array(n);
    ticks.set(this.ticks);
    sizes.set(this.sizes);
    orders.set(this.orders);
    this.ticks = ticks;
    this.sizes = sizes;
    this.orders = orders;
  }
}

export class BookStore {
  readonly grid: TickGrid;
  readonly bids = new BookSide('bid');
  readonly asks = new BookSide('ask');
  seq: number | null = null;
  levels = 0;
  heard = 0;
  gapPending = false;
  version = 0;

  constructor(grid: TickGrid) {
    this.grid = grid;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.seq = null;
    this.heard = 0;
    this.gapPending = false;
    this.version++;
  }

  isStale(now: number, afterMs = BOOK_STALE_MS): boolean {
    return this.seq === null || this.gapPending || now - this.heard > afterMs;
  }

  behindMs(now: number): number {
    return this.heard === 0 ? 0 : Math.max(0, now - this.heard);
  }

  apply(m: DepthMessage, now: number): BookApply {
    if (m.kind === 'heartbeat') {
      if (this.seq === null || m.seq < this.seq) return 'stale';
      if (m.seq !== this.seq || this.gapPending) return this.gap();
      this.heard = now;
      return 'alive';
    }
    if (m.kind === 'snapshot') {
      if (this.seq !== null && !this.gapPending && m.seq <= this.seq) return 'stale';
      this.bids.clear();
      this.asks.clear();
      this.fill(this.bids, m.bids);
      this.fill(this.asks, m.asks);
      this.gapPending = false;
    } else {
      if (this.seq === null || this.gapPending) return this.gap();
      if (m.seq <= this.seq) return 'stale';
      if (m.seq !== this.seq + 1) return this.gap();
      this.patch(this.bids, m.bids);
      this.patch(this.asks, m.asks);
      this.bids.truncate(m.levels);
      this.asks.truncate(m.levels);
    }
    this.seq = m.seq;
    this.levels = m.levels;
    this.heard = now;
    this.version++;
    return 'applied';
  }

  private gap(): BookApply {
    this.gapPending = true;
    return 'gap';
  }

  private fill(side: BookSide, levels: readonly BookLevelInput[]): void {
    for (const l of levels) side.set(this.grid.toTick(l[0]), l[1], l.length > 2 ? l[2]! : ORDERS_UNCOUNTED);
  }

  private patch(side: BookSide, levels: readonly BookLevelInput[]): void {
    for (const l of levels) side.set(this.grid.toTick(l[0]), l[1], l.length > 2 ? l[2]! : ORDERS_UNCOUNTED);
  }

  get bestBid(): number {
    return this.bids.length ? this.bids.ticks[0]! : Number.NaN;
  }

  get bestAsk(): number {
    return this.asks.length ? this.asks.ticks[0]! : Number.NaN;
  }

  sizeAt(side: 'bid' | 'ask', tick: number): number {
    return (side === 'bid' ? this.bids : this.asks).sizeAt(tick);
  }

  rowSize(side: 'bid' | 'ask', rowLow: number, rowTicks: number): number {
    return (side === 'bid' ? this.bids : this.asks).sumRange(rowLow, rowLow + Math.max(1, rowTicks) - 1);
  }

  rowOrders(side: 'bid' | 'ask', rowLow: number, rowTicks: number): number {
    const s = side === 'bid' ? this.bids : this.asks;
    let n = 0;
    for (let t = rowLow; t < rowLow + Math.max(1, rowTicks); t++) {
      const i = s.indexOf(t);
      if (i < 0) continue;
      const o = s.orders[i]!;
      if (o < 0) return ORDERS_UNCOUNTED;
      n += o;
    }
    return n;
  }

  medianSize(depth = 20): number {
    const held = this.median;
    if (held?.version === this.version && held.depth === depth) return held.size;
    const size = this.computeMedian(depth);
    this.median = { version: this.version, depth, size };
    return size;
  }

  private median: { version: number; depth: number; size: number } | null = null;

  private computeMedian(depth: number): number {
    const nb = Math.min(depth, this.bids.length);
    const na = Math.min(depth, this.asks.length);
    const n = nb + na;
    if (n === 0) return 0;
    const all = new Float64Array(n);
    all.set(this.bids.sizes.subarray(0, nb), 0);
    all.set(this.asks.sizes.subarray(0, na), nb);
    all.sort();
    return n % 2 ? all[(n - 1) / 2]! : (all[n / 2 - 1]! + all[n / 2]!) / 2;
  }

  wallSize(multiple = 4, depth = 20): number {
    const m = this.medianSize(depth);
    return m > 0 ? m * multiple : Infinity;
  }

  get bytes(): number {
    const side = (s: BookSide) => s.ticks.byteLength + s.sizes.byteLength + s.orders.byteLength;
    return side(this.bids) + side(this.asks);
  }
}
