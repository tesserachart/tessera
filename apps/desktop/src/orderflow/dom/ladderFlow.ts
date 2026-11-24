import type { Side } from '@tessera/protocol';

export const SAMPLE_MS = 250;
export const DEFAULT_WINDOW_MS = 10_000;
const SAMPLE_LEVELS = 100;

export interface SampledBook {
  readonly bids: { readonly ticks: Int32Array; readonly sizes: Float64Array; readonly length: number };
  readonly asks: { readonly ticks: Int32Array; readonly sizes: Float64Array; readonly length: number };
  sizeAt(side: 'bid' | 'ask', tick: number): number;
}

export interface SampledTape {
  readonly start: number;
  readonly end: number;
  readonly epoch: number;
  tickAt(i: number): number;
  sizeAt(i: number): number;
  sideAt(i: number): number;
}

export const levelKey = (side: 'bid' | 'ask', tick: number): number => tick * 2 + (side === 'bid' ? 1 : 0);

interface Sample {
  t: number;
  sizes: Map<number, number>;
  traded: Map<number, number>;
}

function add(m: Map<number, number>, k: number, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v);
}

export class LevelFlow {
  private samples: Sample[] = [];
  private pending = new Map<number, number>();
  private readonly cum = new Map<number, number>();
  private cursor = 0;
  private epoch = -1;
  private deltas = new Map<number, number>();
  private refills = new Map<number, number>();
  version = 0;

  constructor(
    readonly windowMs = DEFAULT_WINDOW_MS,
    readonly lot = 1,
  ) {}

  syncTape(tape: SampledTape): void {
    if (tape.epoch !== this.epoch || this.cursor > tape.end) {
      this.epoch = tape.epoch;
      this.cursor = tape.end;
      this.pending.clear();
      this.cum.clear();
      this.samples = [];
      return;
    }
    if (this.cursor < tape.start) this.cursor = tape.start;
    for (; this.cursor < tape.end; this.cursor++) {
      const i = this.cursor;
      const side = tape.sideAt(i);
      if (side === 0) continue;
      const k = levelKey(side < 0 ? 'bid' : 'ask', tape.tickAt(i));
      const size = tape.sizeAt(i);
      add(this.pending, k, size);
      add(this.cum, k, size);
    }
  }

  sample(book: SampledBook, now: number): boolean {
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.t < SAMPLE_MS) return false;
    const sizes = new Map<number, number>();
    for (const [side, s] of [
      ['bid', book.bids],
      ['ask', book.asks],
    ] as const) {
      const n = Math.min(SAMPLE_LEVELS, s.length);
      for (let i = 0; i < n; i++) sizes.set(levelKey(side, s.ticks[i]!), s.sizes[i]!);
    }
    this.samples.push({ t: now, sizes, traded: this.pending });
    this.pending = new Map();
    while (this.samples.length > 2 && this.samples[1]!.t <= now - this.windowMs) this.samples.shift();
    this.measure();
    return true;
  }

  private measure(): void {
    const s = this.samples;
    const deltas = new Map<number, number>();
    const refills = new Map<number, number>();
    if (s.length >= 2) {
      const first = s[0]!;
      const now = s[s.length - 1]!;
      const traded = new Map<number, number>();
      for (let k = 1; k < s.length; k++) for (const [key, v] of s[k]!.traded) add(traded, key, v);
      const keys = new Set<number>([...first.sizes.keys(), ...now.sizes.keys(), ...traded.keys()]);
      for (const key of keys) {
        const d = (now.sizes.get(key) ?? 0) - (first.sizes.get(key) ?? 0) + (traded.get(key) ?? 0);
        if (Math.abs(d) >= this.lot * 0.5) deltas.set(key, d);
      }
      for (const [key, vol] of traded) {
        let shown = 0;
        let held = true;
        for (const sample of s) {
          const size = sample.sizes.get(key) ?? 0;
          if (size <= 0) {
            held = false;
            break;
          }
          shown = Math.max(shown, size);
        }
        if (held && shown > 0 && vol >= shown + this.lot) refills.set(key, Math.floor(vol / shown));
      }
    }
    this.deltas = deltas;
    this.refills = refills;
    this.version++;
  }

  change(side: 'bid' | 'ask', low: number, rowTicks: number): number {
    let d = 0;
    for (let t = low; t < low + rowTicks; t++) d += this.deltas.get(levelKey(side, t)) ?? 0;
    return d;
  }

  refilled(side: 'bid' | 'ask', low: number, rowTicks: number): number {
    let n = 0;
    for (let t = low; t < low + rowTicks; t++) n = Math.max(n, this.refills.get(levelKey(side, t)) ?? 0);
    return n;
  }

  tradedInto(side: 'bid' | 'ask', tick: number): number {
    return this.cum.get(levelKey(side, tick)) ?? 0;
  }
}

export interface QueuedOrder {
  id: string;
  side: Side;
  tick: number;
  qty: number;
  brokerAhead: number | null;
}

export class QueueEstimate {
  private readonly held = new Map<string, { tick: number; ahead: number; traded: number }>();

  update(orders: readonly QueuedOrder[], book: SampledBook, flow: LevelFlow): void {
    const seen = new Set<string>();
    for (const o of orders) {
      seen.add(o.id);
      const level = o.side === 'buy' ? 'bid' : 'ask';
      const shown = book.sizeAt(level, o.tick);
      const traded = flow.tradedInto(level, o.tick);
      const h = this.held.get(o.id);
      if (h?.tick !== o.tick) {
        this.held.set(o.id, { tick: o.tick, ahead: Math.max(0, shown - o.qty), traded });
        continue;
      }
      h.ahead = Math.max(0, Math.min(h.ahead - (traded - h.traded), shown - o.qty));
      h.traded = traded;
    }
    for (const id of [...this.held.keys()]) if (!seen.has(id)) this.held.delete(id);
  }

  ahead(o: Pick<QueuedOrder, 'id' | 'brokerAhead'>): number | null {
    if (o.brokerAhead !== null) return o.brokerAhead;
    return this.held.get(o.id)?.ahead ?? null;
  }
}
