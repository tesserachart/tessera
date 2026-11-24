import type { TickGrid } from './ticks.ts';

const BUY = 1;
const SELL = 2;
const SIDE_BITS = 3;
const HAS_ORDER = 4;

export const TAPE_CAPACITY = 262_144;

export type PrintInput =
  readonly [number, number, number, number] | readonly [number, number, number, number, number] | readonly number[];

export interface TradeBatch {
  seq: number;
  trades: readonly PrintInput[];
}

export type TapeApply = 'applied' | 'stale' | 'gap';

export type AggressorSign = -1 | 0 | 1;

export class TradeTape {
  readonly grid: TickGrid;
  readonly capacity: number;
  private readonly mask: number;
  readonly ns: Float64Array;
  readonly tick: Int32Array;
  readonly size: Float32Array;
  readonly order: Uint32Array;
  readonly flags: Uint8Array;
  end = 0;
  seq: number | null = null;
  version = 0;
  epoch = 0;

  constructor(grid: TickGrid, capacity = TAPE_CAPACITY) {
    this.grid = grid;
    let n = 1;
    while (n < capacity) n *= 2;
    this.capacity = n;
    this.mask = n - 1;
    this.ns = new Float64Array(n);
    this.tick = new Int32Array(n);
    this.size = new Float32Array(n);
    this.order = new Uint32Array(n);
    this.flags = new Uint8Array(n);
  }

  get start(): number {
    return Math.max(0, this.end - this.capacity);
  }

  get length(): number {
    return this.end - this.start;
  }

  slot(i: number): number {
    return i & this.mask;
  }

  reset(): void {
    this.end = 0;
    this.seq = null;
    this.version++;
    this.epoch++;
  }

  applySnapshot(b: TradeBatch): TapeApply {
    const n = b.trades.length;
    const held = this.seq;
    if (held !== null && b.seq - n <= held && held <= b.seq) {
      this.pushAll(b.trades, n - (b.seq - held));
    } else {
      this.end = 0;
      this.epoch++;
      this.pushAll(b.trades, 0);
    }
    this.seq = b.seq;
    this.version++;
    return 'applied';
  }

  apply(b: TradeBatch): TapeApply {
    const held = this.seq;
    if (held === null) return 'gap';
    if (b.seq <= held) return 'stale';
    const n = b.trades.length;
    const first = b.seq - n;
    if (first > held) return 'gap';
    this.pushAll(b.trades, held - first);
    this.seq = b.seq;
    this.version++;
    return 'applied';
  }

  private pushAll(trades: readonly PrintInput[], from: number): void {
    for (let k = Math.max(0, from); k < trades.length; k++) {
      const p = trades[k]!;
      this.push(p[0], p[1], p[2], p[3], p.length > 4 ? p[4]! : null);
    }
  }

  push(ns: number, price: number, size: number, side: number, order: number | null): void {
    const s = this.end & this.mask;
    this.ns[s] = ns;
    this.tick[s] = this.grid.toTick(price);
    this.size[s] = size;
    const aggressor = side > 0 ? BUY : side < 0 ? SELL : 0;
    if (order === null) {
      this.flags[s] = aggressor;
      this.order[s] = 0;
    } else {
      this.flags[s] = aggressor | HAS_ORDER;
      this.order[s] = order >>> 0;
    }
    this.end++;
  }

  msAt(i: number): number {
    return this.ns[i & this.mask]! / 1e6;
  }

  nsAt(i: number): number {
    return this.ns[i & this.mask]!;
  }

  tickAt(i: number): number {
    return this.tick[i & this.mask]!;
  }

  priceAt(i: number): number {
    return this.grid.toPrice(this.tick[i & this.mask]!);
  }

  sizeAt(i: number): number {
    return this.size[i & this.mask]!;
  }

  sideAt(i: number): AggressorSign {
    const a = this.flags[i & this.mask]! & SIDE_BITS;
    return a === BUY ? 1 : a === SELL ? -1 : 0;
  }

  orderAt(i: number): number | null {
    const s = i & this.mask;
    return this.flags[s]! & HAS_ORDER ? this.order[s]! : null;
  }

  lowerBound(ns: number): number {
    let lo = this.start;
    let hi = this.end;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.ns[mid & this.mask]! < ns) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  upperBound(ns: number): number {
    let lo = this.start;
    let hi = this.end;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.ns[mid & this.mask]! <= ns) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  get bytes(): number {
    return (
      this.ns.byteLength + this.tick.byteLength + this.size.byteLength + this.order.byteLength + this.flags.byteLength
    );
  }
}
