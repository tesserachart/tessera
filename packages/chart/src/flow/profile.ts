import type { FootprintStore } from './footprintStore.ts';
import { floorDiv } from './ticks.ts';

export function pointOfControl(volumes: ArrayLike<number>): number {
  let best = -1;
  let bestDist = Infinity;
  let max = -Infinity;
  const mid = volumes.length - 1;
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i]!;
    const dist = Math.abs(2 * i - mid);
    if (v > max || (v === max && dist < bestDist)) {
      max = v;
      best = i;
      bestDist = dist;
    }
  }
  return Math.max(0, best);
}

export function valueAreaBand(volumes: ArrayLike<number>, poc: number, share: number): [number, number, number] {
  let total = 0;
  for (let i = 0, n = volumes.length; i < n; i++) total += volumes[i]!;
  const target = total * Math.min(1, Math.max(0, share));
  let a = poc;
  let b = poc;
  let held = volumes[poc] ?? 0;
  const eps = total * 1e-12;
  const n = volumes.length;
  while (held + eps < target) {
    const up = b + 1 < n ? volumes[b + 1]! : undefined;
    const down = a > 0 ? volumes[a - 1]! : undefined;
    if (up === undefined && down === undefined) break;
    if (up !== undefined && down !== undefined && up === down) {
      a -= 1;
      b += 1;
      held += up + down;
    } else if (up !== undefined && (down === undefined || up > down)) {
      b += 1;
      held += up;
    } else {
      a -= 1;
      held += down!;
    }
  }
  return [a, b, held];
}

export interface Profile {
  rowTicks: number;
  lowTick: number;
  rows: number;
  volume: Float64Array;
  buy: Float64Array;
  sell: Float64Array;
  poc: number;
  val: number;
  vah: number;
  valueAreaVolume: number;
  total: number;
  maxVolume: number;
}

export class ProfileAccumulator {
  readonly rowTicks: number;
  lowTick = 0;
  rows = 0;
  buy = new Float64Array(0);
  sell = new Float64Array(0);

  constructor(rowTicks: number) {
    this.rowTicks = Math.max(1, Math.round(rowTicks));
  }

  clear(): void {
    this.rows = 0;
  }

  add(tick: number, buy: number, sell: number): void {
    const row = floorDiv(tick, this.rowTicks) * this.rowTicks;
    this.cover(row, row);
    const r = (row - this.lowTick) / this.rowTicks;
    this.buy[r] = this.buy[r]! + buy;
    this.sell[r] = this.sell[r]! + sell;
  }

  addRows(lowTick: number, rowTicks: number, rows: number, bid: ArrayLike<number>, ask: ArrayLike<number>): void {
    if (rows === 0) return;
    if (rowTicks === this.rowTicks && lowTick % this.rowTicks === 0) {
      this.cover(lowTick, lowTick + (rows - 1) * rowTicks);
      const off = (lowTick - this.lowTick) / this.rowTicks;
      for (let r = 0; r < rows; r++) {
        this.buy[off + r] = this.buy[off + r]! + ask[r]!;
        this.sell[off + r] = this.sell[off + r]! + bid[r]!;
      }
      return;
    }
    for (let r = 0; r < rows; r++) {
      const b = bid[r]!;
      const a = ask[r]!;
      if (a !== 0 || b !== 0) this.add(lowTick + r * rowTicks, a, b);
    }
  }

  private cover(low: number, high: number): void {
    if (this.rows > 0 && low >= this.lowTick && high <= this.lowTick + (this.rows - 1) * this.rowTicks) return;
    const top = this.rows > 0 ? Math.max(high, this.lowTick + (this.rows - 1) * this.rowTicks) : high;
    const lo = this.rows > 0 ? Math.min(low, this.lowTick) : low;
    const rows = (top - lo) / this.rowTicks + 1;
    const buy = new Float64Array(rows);
    const sell = new Float64Array(rows);
    if (this.rows > 0) {
      const off = (this.lowTick - lo) / this.rowTicks;
      buy.set(this.buy.subarray(0, this.rows), off);
      sell.set(this.sell.subarray(0, this.rows), off);
    }
    this.buy = buy;
    this.sell = sell;
    this.lowTick = lo;
    this.rows = rows;
  }

  profile(share = 0.7): Profile {
    const rows = this.rows;
    const volume = new Float64Array(rows);
    let total = 0;
    let maxVolume = 0;
    for (let r = 0; r < rows; r++) {
      const v = this.buy[r]! + this.sell[r]!;
      volume[r] = v;
      total += v;
      if (v > maxVolume) maxVolume = v;
    }
    const empty = total <= 0;
    const poc = empty ? -1 : pointOfControl(volume);
    const [val, vah, held] = empty ? [-1, -1, 0] : valueAreaBand(volume, poc, share);
    return {
      rowTicks: this.rowTicks,
      lowTick: this.lowTick,
      rows,
      volume,
      buy: this.buy.slice(0, rows),
      sell: this.sell.slice(0, rows),
      poc,
      val,
      vah,
      valueAreaVolume: held,
      total,
      maxVolume,
    };
  }
}

export function footprintProfile(
  store: FootprintStore,
  from: number,
  to: number,
  rowTicks: number,
  share = 0.7,
): Profile | null {
  const acc = new ProfileAccumulator(rowTicks);
  let any = false;
  for (let i = Math.max(0, from); i <= Math.min(to, store.length - 1); i++) {
    const bar = store.at(i)!;
    const v = store.view(bar, Math.max(bar.baseTicks, acc.rowTicks));
    acc.addRows(v.lowTick, v.rowTicks, v.rows, v.bid, v.ask);
    any ||= v.rows > 0;
  }
  return any ? acc.profile(share) : null;
}

export interface SessionPoc {
  tick: number;
  rowTicks: number;
  lastBar: number;
  label: string;
}

export function nakedPocs(
  pocs: readonly SessionPoc[],
  bars: { length: number; lowTick(i: number): number; highTick(i: number): number },
  sessions = 5,
): SessionPoc[] {
  const out: SessionPoc[] = [];
  const recent = [...pocs].sort((a, b) => b.lastBar - a.lastBar).slice(0, Math.max(0, sessions));
  for (const p of recent) {
    let touched = false;
    const top = p.tick + p.rowTicks - 1;
    for (let i = p.lastBar + 1; i < bars.length; i++) {
      if (bars.lowTick(i) <= top && bars.highTick(i) >= p.tick) {
        touched = true;
        break;
      }
    }
    if (!touched) out.push(p);
  }
  return out;
}

const NODE_SHARE = 0.12;

export function volumeNodes(volumes: ArrayLike<number>, share = NODE_SHARE): { hvn: number[]; lvn: number[] } {
  const n = volumes.length;
  const hvn: number[] = [];
  const lvn: number[] = [];
  if (n < 5) return { hvn, lvn };
  const k = Math.max(1, Math.round(n / 50));
  const sm = new Float64Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) {
      sum += volumes[j]!;
      c++;
    }
    sm[i] = sum / c;
    if (sm[i]! > max) max = sm[i]!;
  }
  if (!(max > 0)) return { hvn, lvn };
  const delta = share * max;
  let hi = -Infinity;
  let lo = Infinity;
  let hiAt = 0;
  let loAt = 0;
  let seekPeak = true;
  for (let i = 0; i < n; i++) {
    const v = sm[i]!;
    if (v > hi) {
      hi = v;
      hiAt = i;
    }
    if (v < lo) {
      lo = v;
      loAt = i;
    }
    if (seekPeak && v < hi - delta) {
      hvn.push(hiAt);
      lo = v;
      loAt = i;
      seekPeak = false;
    } else if (!seekPeak && v > lo + delta) {
      lvn.push(loAt);
      hi = v;
      hiAt = i;
      seekPeak = true;
    }
  }
  return { hvn, lvn };
}
