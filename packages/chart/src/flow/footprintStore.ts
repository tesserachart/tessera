import { CHART_MAX_BARS } from '../store.ts';
import { valueAreaBand } from './profile.ts';
import { floorDiv, type TickGrid } from './ticks.ts';

const VIEWS_PER_BAR = 3;

export type CellInput = readonly [rowFloor: number, bid: number, ask: number, trades?: number] | readonly number[];

export interface FootprintInput {
  t: number;
  row: number;
  cells: readonly CellInput[];
  deltaHigh: number | null;
  deltaLow: number | null;
}

export interface FootprintMessage {
  bar: FootprintInput;
  closed: boolean;
  partial: boolean;
}

export class FootprintBar {
  readonly t: number;
  readonly baseTicks: number;
  lowTick = 0;
  rows = 0;
  bid: Float32Array = new Float32Array(0);
  ask: Float32Array = new Float32Array(0);
  trades: Float32Array = new Float32Array(0);
  closed = false;
  deltaHigh: number | null = null;
  deltaLow: number | null = null;
  version = 0;
  readonly views = new Map<number, FootprintView>();

  constructor(t: number, baseTicks: number) {
    this.t = t;
    this.baseTicks = Math.max(1, baseTicks);
  }

  get highTick(): number {
    return this.lowTick + (this.rows - 1) * this.baseTicks;
  }

  get volume(): number {
    let v = 0;
    for (let r = 0; r < this.rows; r++) v += this.bid[r]! + this.ask[r]!;
    return v;
  }

  get delta(): number {
    let d = 0;
    for (let r = 0; r < this.rows; r++) d += this.ask[r]! - this.bid[r]!;
    return d;
  }

  cover(low: number, high: number): void {
    if (this.rows > 0 && low >= this.lowTick && high <= this.highTick) return;
    const lo = this.rows > 0 ? Math.min(low, this.lowTick) : low;
    const hi = this.rows > 0 ? Math.max(high, this.highTick) : high;
    const rows = (hi - lo) / this.baseTicks + 1;
    const bid = new Float32Array(rows);
    const ask = new Float32Array(rows);
    const trades = new Float32Array(rows);
    if (this.rows > 0) {
      const off = (this.lowTick - lo) / this.baseTicks;
      bid.set(this.bid.subarray(0, this.rows), off);
      ask.set(this.ask.subarray(0, this.rows), off);
      trades.set(this.trades.subarray(0, this.rows), off);
    }
    this.lowTick = lo;
    this.rows = rows;
    this.bid = bid;
    this.ask = ask;
    this.trades = trades;
  }
}

export interface FootprintView {
  readonly bar: FootprintBar;
  readonly version: number;
  readonly rowTicks: number;
  readonly lowTick: number;
  readonly rows: number;
  readonly bid: Float32Array;
  readonly ask: Float32Array;
  readonly trades: Float32Array;
  readonly poc: number;
  readonly tradesPoc: number;
  readonly bidPeak: number;
  readonly askPeak: number;
  readonly maxVolume: number;
  readonly maxTrades: number;
  readonly maxSide: number;
  readonly maxDelta: number;
  readonly volume: number;
  readonly delta: number;
  readonly deltaPoc: number;
  readonly vaLow: number;
  readonly vaHigh: number;
  readonly unfinishedHigh: boolean;
  readonly unfinishedLow: boolean;
}

const BAR_VALUE_AREA = 0.7;

export interface TintScale {
  readonly volume: number;
  readonly delta: number;
}

const TINT_BARS = 1000;
const TINT_REFERENCE = 1.5;

function tintScaleOf(bars: readonly FootprintBar[], rowTicks: number, closedOnly: boolean): TintScale {
  let rows = 0;
  let volume = 0;
  let deltaRows = 0;
  let delta = 0;
  let seen = 0;
  for (let i = bars.length - 1; i >= 0 && seen < TINT_BARS; i--) {
    const bar = bars[i]!;
    if (closedOnly && !bar.closed) continue;
    seen++;
    const size = Math.max(bar.baseTicks, Math.round(rowTicks));
    let row = Number.NaN;
    let bid = 0;
    let ask = 0;
    for (let r = 0; r <= bar.rows; r++) {
      const at = r < bar.rows ? floorDiv(bar.lowTick + r * bar.baseTicks, size) : Number.NaN;
      if (at !== row) {
        if (bid + ask > 0) {
          rows++;
          volume += bid + ask;
        }
        if (ask !== bid) {
          deltaRows++;
          delta += Math.abs(ask - bid);
        }
        row = at;
        bid = 0;
        ask = 0;
      }
      if (r < bar.rows) {
        bid += bar.bid[r]!;
        ask += bar.ask[r]!;
      }
    }
  }
  return {
    volume: rows > 0 ? (TINT_REFERENCE * volume) / rows : 0,
    delta: deltaRows > 0 ? (TINT_REFERENCE * delta) / deltaRows : 0,
  };
}

export function pocOf(volumeAt: (r: number) => number, rows: number): number {
  let best = -1;
  let max = 0;
  let dist = Infinity;
  const mid2 = rows - 1;
  for (let r = 0; r < rows; r++) {
    const v = volumeAt(r);
    const d = Math.abs(2 * r - mid2);
    if (v > max || (v === max && v > 0 && d < dist)) {
      best = r;
      max = v;
      dist = d;
    }
  }
  return best;
}

export class FootprintStore {
  readonly grid: TickGrid;
  readonly capacity: number;
  private bars: FootprintBar[] = [];
  private readonly byTime = new Map<number, FootprintBar>();
  version = 0;
  generation = 0;
  settledVersion = 0;
  private tint: { key: string; scale: TintScale } | null = null;

  constructor(grid: TickGrid, capacity = CHART_MAX_BARS) {
    this.grid = grid;
    this.capacity = Math.max(1, capacity);
  }

  get length(): number {
    return this.bars.length;
  }

  at(i: number): FootprintBar | undefined {
    return this.bars[i];
  }

  get(t: number): FootprintBar | undefined {
    return this.byTime.get(t);
  }

  get firstTime(): number | null {
    return this.bars[0]?.t ?? null;
  }

  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.bars[mid]!.t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  setHistory(inputs: readonly FootprintInput[], formingLast = false): void {
    this.bars = [];
    this.byTime.clear();
    const sorted = [...inputs].sort((a, b) => a.t - b.t);
    sorted.forEach((input, k) => {
      const bar = this.build(input);
      bar.closed = !(formingLast && k === sorted.length - 1);
      this.insert(bar);
    });
    this.trim();
    this.version++;
    this.generation++;
    this.settledVersion++;
  }

  addOlder(inputs: readonly FootprintInput[]): number {
    const fits = inputs
      .filter((input) => !this.byTime.has(input.t))
      .sort((a, b) => b.t - a.t)
      .slice(0, Math.max(0, this.capacity - this.bars.length));
    if (fits.length === 0) return 0;
    const built = fits.reverse().map((input) => {
      const bar = this.build(input);
      bar.closed = true;
      return bar;
    });
    if (built[built.length - 1]!.t < (this.firstTime ?? Infinity)) {
      this.bars = built.concat(this.bars);
      for (const bar of built) this.byTime.set(bar.t, bar);
    } else for (const bar of built) this.insert(bar);
    this.version++;
    this.generation++;
    this.settledVersion++;
    return fits.length;
  }

  apply(m: FootprintMessage): 'applied' | 'reload' {
    const held = this.byTime.get(m.bar.t);
    if (m.closed || !held) {
      if (!held && m.partial && !m.closed) return 'reload';
      const bar = this.build(m.bar);
      bar.closed = m.closed;
      if (held) {
        bar.version = held.version + 1;
        this.replace(held, bar);
      } else this.insert(bar);
      this.trim();
      this.settledVersion++;
    } else {
      if (held !== this.bars[this.bars.length - 1]) this.settledVersion++;
      this.merge(held, m.bar);
    }
    this.version++;
    return 'applied';
  }

  private build(input: FootprintInput): FootprintBar {
    const bar = new FootprintBar(input.t, Math.max(1, Math.round(input.row / this.grid.tick)));
    this.merge(bar, input);
    bar.deltaHigh = input.deltaHigh;
    bar.deltaLow = input.deltaLow;
    return bar;
  }

  private merge(bar: FootprintBar, input: FootprintInput): void {
    const cells = input.cells;
    if (cells.length > 0) {
      let low = Infinity;
      let high = -Infinity;
      for (const c of cells) {
        const t = this.rowTick(bar, c[0]);
        if (t < low) low = t;
        if (t > high) high = t;
      }
      bar.cover(low, high);
      for (const c of cells) {
        const r = (this.rowTick(bar, c[0]) - bar.lowTick) / bar.baseTicks;
        if (c[1] > bar.bid[r]!) bar.bid[r] = c[1]!;
        if (c[2] > bar.ask[r]!) bar.ask[r] = c[2]!;
        const trades = c[3] ?? 0;
        if (trades > bar.trades[r]!) bar.trades[r] = trades;
      }
    }
    bar.deltaHigh = widen(bar.deltaHigh, input.deltaHigh, Math.max);
    bar.deltaLow = widen(bar.deltaLow, input.deltaLow, Math.min);
    bar.version++;
  }

  private rowTick(bar: FootprintBar, price: number): number {
    return floorDiv(this.grid.toTick(price), bar.baseTicks) * bar.baseTicks;
  }

  private insert(bar: FootprintBar): void {
    const i = this.indexAtOrBefore(bar.t) + 1;
    this.bars.splice(i, 0, bar);
    this.byTime.set(bar.t, bar);
  }

  private replace(held: FootprintBar, bar: FootprintBar): void {
    const i = this.bars.indexOf(held);
    this.bars[i] = bar;
    this.byTime.set(bar.t, bar);
  }

  private trim(): void {
    const extra = this.bars.length - this.capacity;
    if (extra <= 0) return;
    for (const bar of this.bars.splice(0, extra)) this.byTime.delete(bar.t);
  }

  tintScale(rowTicks: number): TintScale {
    let anyClosed = false;
    for (let i = this.bars.length - 1; i >= 0 && !anyClosed; i--) anyClosed = this.bars[i]!.closed;
    const key = [rowTicks, this.generation, this.settledVersion, anyClosed ? '' : this.version].join('|');
    if (this.tint?.key === key) return this.tint.scale;
    const scale = tintScaleOf(this.bars, rowTicks, anyClosed);
    this.tint = { key, scale };
    return scale;
  }

  view(bar: FootprintBar, rowTicks: number): FootprintView {
    const size = Math.max(bar.baseTicks, Math.round(rowTicks));
    const held = bar.views.get(size);
    if (held?.version === bar.version) return held;
    const view = merged(bar, size);
    if (!held && bar.views.size >= VIEWS_PER_BAR) bar.views.delete(bar.views.keys().next().value!);
    bar.views.delete(size);
    bar.views.set(size, view);
    return view;
  }

  get bytes(): number {
    let b = 0;
    for (const bar of this.bars) b += bar.bid.byteLength + bar.ask.byteLength + bar.trades.byteLength + 96;
    return b;
  }
}

function widen(a: number | null, b: number | null, pick: (x: number, y: number) => number): number | null {
  return a === null || b === null ? (a ?? b) : pick(a, b);
}

function merged(bar: FootprintBar, rowTicks: number): FootprintView {
  let bid: Float32Array;
  let ask: Float32Array;
  let trades: Float32Array;
  let lowTick: number;
  let rows: number;
  if (rowTicks === bar.baseTicks || bar.rows === 0) {
    bid = bar.bid;
    ask = bar.ask;
    trades = bar.trades;
    lowTick = bar.lowTick;
    rows = bar.rows;
  } else {
    lowTick = floorDiv(bar.lowTick, rowTicks) * rowTicks;
    const top = floorDiv(bar.highTick, rowTicks) * rowTicks;
    rows = (top - lowTick) / rowTicks + 1;
    bid = new Float32Array(rows);
    ask = new Float32Array(rows);
    trades = new Float32Array(rows);
    for (let r = 0; r < bar.rows; r++) {
      const t = bar.lowTick + r * bar.baseTicks;
      const k = (floorDiv(t, rowTicks) * rowTicks - lowTick) / rowTicks;
      bid[k] = bid[k]! + bar.bid[r]!;
      ask[k] = ask[k]! + bar.ask[r]!;
      trades[k] = trades[k]! + bar.trades[r]!;
    }
  }
  let maxVolume = 0;
  let maxTrades = 0;
  let maxSide = 0;
  let maxDelta = 0;
  let volume = 0;
  let delta = 0;
  for (let r = 0; r < rows; r++) {
    const b = bid[r]!;
    const a = ask[r]!;
    const v = a + b;
    volume += v;
    delta += a - b;
    if (v > maxVolume) maxVolume = v;
    if (trades[r]! > maxTrades) maxTrades = trades[r]!;
    if (b > maxSide) maxSide = b;
    if (a > maxSide) maxSide = a;
    if (Math.abs(a - b) > maxDelta) maxDelta = Math.abs(a - b);
  }
  const poc = pocOf((r) => bid[r]! + ask[r]!, rows);
  const tradesPoc = pocOf((r) => trades[r]!, rows);
  const bidPeak = pocOf((r) => bid[r]!, rows);
  const askPeak = pocOf((r) => ask[r]!, rows);
  let deltaPoc = -1;
  for (let r = 0; r < rows; r++) if (maxDelta > 0 && Math.abs(ask[r]! - bid[r]!) === maxDelta) deltaPoc = r;
  let vaLow = -1;
  let vaHigh = -1;
  if (poc >= 0) {
    const vols = new Float64Array(rows);
    for (let r = 0; r < rows; r++) vols[r] = bid[r]! + ask[r]!;
    [vaLow, vaHigh] = valueAreaBand(vols, poc, BAR_VALUE_AREA);
  }
  let hi = rows - 1;
  while (hi >= 0 && bid[hi]! + ask[hi]! <= 0) hi--;
  let lo = 0;
  while (lo < rows && bid[lo]! + ask[lo]! <= 0) lo++;
  return {
    bar,
    version: bar.version,
    rowTicks,
    lowTick,
    rows,
    bid,
    ask,
    trades,
    poc,
    tradesPoc,
    bidPeak,
    askPeak,
    maxVolume,
    maxTrades,
    maxSide,
    maxDelta,
    volume,
    delta,
    deltaPoc,
    vaLow,
    vaHigh,
    unfinishedHigh: hi >= 0 && bid[hi]! > 0 && ask[hi]! > 0,
    unfinishedLow: lo < rows && bid[lo]! > 0 && ask[lo]! > 0,
  };
}
