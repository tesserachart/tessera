import type { AggressorSign, TradeTape } from './tradeTape.ts';

export const CONTINUATION_NS = 5_000_000;
export const CONTINUATION_TICKS = 2;

export type AggPrintInput =
  | readonly [tNs: number, price: number, size: number, side: number]
  | readonly [tNs: number, price: number, size: number, side: number, order: number];

export interface AggOrder {
  t: number;
  price: number;
  size: number;
  side: AggressorSign;
  prints: number;
  levels: number;
  orders: number;
}

type Join = 0 | 1 | 2;

export interface Grouping {
  joinOrders: boolean;
  reachLimit: boolean;
}

export const TESSERA_GROUPING: Grouping = { joinOrders: true, reachLimit: true };

export function groupingKey(g: Grouping): string {
  return `${g.joinOrders ? 'orders' : 'chain'}|${g.reachLimit ? 'reach' : 'walk'}`;
}

interface JoinState {
  side: AggressorSign;
  order: number | null;
  lastT: number;
  lastTick: number;
  lowTick: number;
  highTick: number;
}

export function joinOf(
  o: JoinState,
  t: number,
  tick: number,
  side: AggressorSign,
  order: number | null,
  g: Grouping,
): Join {
  if (side !== o.side) return 0;
  const sameKey = o.order !== null && order !== null && o.order === order;
  if (g.joinOrders && sameKey) return 1;
  if (side === 0) return t === o.lastT && tick === o.lastTick ? 1 : 0;
  const unkeyedAtOnce = t === o.lastT && (o.order === null || order === null);
  if (g.joinOrders && unkeyedAtOnce) return 1;
  const gap = t - o.lastT;
  if (gap < 0 || gap > CONTINUATION_NS) return 0;
  const within =
    side > 0
      ? tick >= o.lastTick && (!g.reachLimit || tick <= o.highTick + CONTINUATION_TICKS)
      : tick <= o.lastTick && (!g.reachLimit || tick >= o.lowTick - CONTINUATION_TICKS);
  if (!within) return 0;
  return sameKey || unkeyedAtOnce ? 1 : 2;
}

function aggressorSign(v: number): AggressorSign {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

interface OpenOrder extends AggOrder, JoinState {
  notional: number;
}

export function aggregatePrints(
  prints: readonly AggPrintInput[],
  tick: number,
  grouping: Grouping = TESSERA_GROUPING,
): AggOrder[] {
  const out: AggOrder[] = [];
  let o: OpenOrder | null = null;
  const close = () => {
    if (o)
      out.push({
        t: o.t,
        price: o.price,
        size: o.size,
        side: o.side,
        prints: o.prints,
        levels: o.levels,
        orders: o.orders,
      });
  };
  for (const p of prints) {
    const [t, price, size, rawSide] = p;
    const side = aggressorSign(rawSide);
    const order = p.length > 4 ? p[4]! : null;
    const k = Math.round(price / tick);
    const join = o ? joinOf(o, t, k, side, order, grouping) : 0;
    if (o && join !== 0) {
      if (k < o.lowTick || k > o.highTick) o.levels++;
      o.lowTick = Math.min(o.lowTick, k);
      o.highTick = Math.max(o.highTick, k);
      o.size += size;
      o.notional += price * size;
      o.price = o.size > 0 ? o.notional / o.size : price;
      o.prints++;
      if (join === 2) o.orders++;
      if (order !== null) o.order = order;
      o.lastT = Math.max(o.lastT, t);
      o.lastTick = k;
      continue;
    }
    close();
    o = {
      t,
      price,
      size,
      side,
      prints: 1,
      levels: 1,
      orders: 1,
      order,
      notional: price * size,
      lastT: t,
      lastTick: k,
      lowTick: k,
      highTick: k,
    };
  }
  close();
  return out;
}

export const AGG_CAPACITY = 131_072;

export class AggTape {
  readonly tape: TradeTape;
  readonly grouping: Grouping;
  readonly capacity: number;
  private readonly mask: number;
  readonly ns: Float64Array;
  readonly tick: Float64Array;
  readonly endTick: Float64Array;
  readonly size: Float64Array;
  readonly side: Int8Array;
  readonly prints: Uint32Array;
  readonly levels: Uint16Array;
  readonly orders: Uint16Array;
  readonly firstPrint: Float64Array;
  end = 0;
  open = false;
  version = 0;
  private cursor = 0;
  private epoch = -1;
  private notional = 0;
  private lowTick = 0;
  private highTick = 0;
  private lastTick = 0;
  private lastT = 0;
  private openOrder: number | null = null;

  constructor(tape: TradeTape, capacity = AGG_CAPACITY, grouping: Grouping = TESSERA_GROUPING) {
    this.tape = tape;
    this.grouping = grouping;
    let n = 1;
    while (n < capacity) n *= 2;
    this.capacity = n;
    this.mask = n - 1;
    this.ns = new Float64Array(n);
    this.tick = new Float64Array(n);
    this.endTick = new Float64Array(n);
    this.size = new Float64Array(n);
    this.side = new Int8Array(n);
    this.prints = new Uint32Array(n);
    this.levels = new Uint16Array(n);
    this.orders = new Uint16Array(n);
    this.firstPrint = new Float64Array(n);
  }

  get start(): number {
    return Math.max(0, this.end - this.capacity);
  }

  get length(): number {
    return this.end - this.start;
  }

  get closedEnd(): number {
    return this.open ? this.end - 1 : this.end;
  }

  sync(): number {
    const tape = this.tape;
    if (tape.epoch !== this.epoch || this.cursor > tape.end) this.restart();
    if (this.cursor < tape.start) {
      this.open = false;
      this.cursor = tape.start;
    }
    const from = this.cursor;
    for (let i = from; i < tape.end; i++) this.add(i);
    this.cursor = tape.end;
    if (tape.end > from) this.version++;
    return tape.end - from;
  }

  private restart(): void {
    this.epoch = this.tape.epoch;
    this.cursor = this.tape.start;
    this.end = 0;
    this.open = false;
    this.version++;
  }

  private add(i: number): void {
    const tape = this.tape;
    const t = tape.nsAt(i);
    const tick = tape.tickAt(i);
    const size = tape.sizeAt(i);
    const side = tape.sideAt(i);
    const order = tape.orderAt(i);
    if (this.open) {
      const s = (this.end - 1) & this.mask;
      const join = joinOf(
        {
          side: aggressorSign(this.side[s]!),
          order: this.openOrder,
          lastT: this.lastT,
          lastTick: this.lastTick,
          lowTick: this.lowTick,
          highTick: this.highTick,
        },
        t,
        tick,
        side,
        order,
        this.grouping,
      );
      if (join !== 0) {
        if (tick < this.lowTick || tick > this.highTick) this.levels[s] = Math.min(65535, this.levels[s]! + 1);
        this.lowTick = Math.min(this.lowTick, tick);
        this.highTick = Math.max(this.highTick, tick);
        this.size[s] = this.size[s]! + size;
        this.notional += tick * size;
        this.tick[s] = this.size[s] > 0 ? this.notional / this.size[s] : tick;
        this.prints[s] = this.prints[s]! + 1;
        if (join === 2) this.orders[s] = Math.min(65535, this.orders[s]! + 1);
        if (order !== null) this.openOrder = order;
        this.endTick[s] = tick;
        this.lastTick = tick;
        this.lastT = Math.max(this.lastT, t);
        return;
      }
      this.open = false;
    }
    const s = this.end & this.mask;
    this.ns[s] = t;
    this.tick[s] = tick;
    this.endTick[s] = tick;
    this.size[s] = size;
    this.side[s] = side;
    this.prints[s] = 1;
    this.levels[s] = 1;
    this.orders[s] = 1;
    this.firstPrint[s] = i;
    this.end++;
    this.open = true;
    this.notional = tick * size;
    this.lowTick = tick;
    this.highTick = tick;
    this.lastTick = tick;
    this.lastT = t;
    this.openOrder = order;
  }

  at(i: number): AggOrder & { firstPrint: number; last: number } {
    const s = i & this.mask;
    return {
      t: this.ns[s]!,
      price: this.tick[s]! * this.tape.grid.tick,
      last: this.endTick[s]! * this.tape.grid.tick,
      size: this.size[s]!,
      side: aggressorSign(this.side[s]!),
      prints: this.prints[s]!,
      levels: this.levels[s]!,
      orders: this.orders[s]!,
      firstPrint: this.firstPrint[s]!,
    };
  }

  seqOf(i: number): number | null {
    const tape = this.tape;
    if (tape.seq === null) return null;
    return tape.seq - (tape.end - this.firstPrint[i & this.mask]!) + 1;
  }

  get bytes(): number {
    return (
      this.ns.byteLength +
      this.tick.byteLength +
      this.endTick.byteLength +
      this.size.byteLength +
      this.side.byteLength +
      this.prints.byteLength +
      this.levels.byteLength +
      this.orders.byteLength +
      this.firstPrint.byteLength
    );
  }
}
