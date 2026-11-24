import type { FootprintView } from './footprintStore.ts';

export interface ImbalanceOptions {
  ratio: number;
  minVolume: number;
  minDifference: number;
  includeZero: boolean;
  stackRows: number;
}

export const DEFAULT_IMBALANCE: Readonly<ImbalanceOptions> = {
  ratio: 3,
  minVolume: 5,
  minDifference: 0,
  includeZero: false,
  stackRows: 3,
};

export const BUY_IMBALANCE = 1;
export const SELL_IMBALANCE = 2;

export interface ImbalanceRows {
  readonly rows: number;
  readonly bid: ArrayLike<number>;
  readonly ask: ArrayLike<number>;
}

export interface RowSpan {
  readonly rows: number;
  readonly lowTick: number;
  readonly rowTicks: number;
}

export function imbalanceFlags(v: ImbalanceRows, o: ImbalanceOptions, out?: Uint8Array): Uint8Array {
  const flags = out && out.length >= v.rows ? out.fill(0, 0, v.rows) : new Uint8Array(v.rows);
  const { bid, ask } = v;
  const min = Math.max(o.minVolume, Number.MIN_VALUE);
  const beats = (side: number, other: number) =>
    side >= min && side - other >= o.minDifference && (other === 0 ? o.includeZero : side >= o.ratio * other);
  for (let r = 0; r < v.rows; r++) {
    if (r > 0 && beats(ask[r]!, bid[r - 1]!)) flags[r]! |= BUY_IMBALANCE;
    if (r < v.rows - 1 && beats(bid[r]!, ask[r + 1]!)) flags[r]! |= SELL_IMBALANCE;
  }
  return flags;
}

export function flagsOnRows(found: RowSpan, flags: Uint8Array, shown: RowSpan, out?: Uint8Array): Uint8Array {
  const marks = out && out.length >= shown.rows ? out.fill(0, 0, shown.rows) : new Uint8Array(shown.rows);
  const rowOf = (tick: number) => Math.floor((tick - shown.lowTick) / shown.rowTicks);
  for (let r = 0; r < found.rows; r++) {
    const f = flags[r]!;
    if (f === 0) continue;
    const low = found.lowTick + r * found.rowTicks;
    const first = Math.max(0, rowOf(low));
    const last = Math.min(shown.rows - 1, rowOf(low + found.rowTicks - 1));
    for (let k = first; k <= last; k++) marks[k]! |= f;
  }
  return marks;
}

export interface Stack {
  side: 'buy' | 'sell';
  low: number;
  high: number;
}

export function stacksOf(flags: Uint8Array, rows: number, minRows: number): Stack[] {
  const out: Stack[] = [];
  const need = Math.max(1, minRows);
  for (const [side, bit] of [
    ['buy', BUY_IMBALANCE],
    ['sell', SELL_IMBALANCE],
  ] as const) {
    let start = -1;
    for (let r = 0; r <= rows; r++) {
      const on = r < rows && (flags[r]! & bit) !== 0;
      if (on && start < 0) start = r;
      else if (!on && start >= 0) {
        if (r - start >= need) out.push({ side, low: start, high: r - 1 });
        start = -1;
      }
    }
  }
  return out.sort((a, b) => a.low - b.low || (a.side === 'buy' ? -1 : 1));
}

export interface Zone {
  side: 'buy' | 'sell';
  lowTick: number;
  highTick: number;
  from: number;
  to: number;
  open: boolean;
}

export interface ZoneBars {
  length: number;
  view(i: number): FootprintView | null;
  lowTick(i: number): number;
  highTick(i: number): number;
  session(i: number): number;
}

export const ZONE_SESSIONS = 3;

export function stackedZones(bars: ZoneBars, from: number, to: number, o: ImbalanceOptions): Zone[] {
  const out: Zone[] = [];
  let flags = new Uint8Array(64);
  const last = bars.length - 1;
  for (let i = Math.max(0, from); i <= Math.min(to, last); i++) {
    const v = bars.view(i);
    if (!v || v.rows === 0) continue;
    if (flags.length < v.rows) flags = new Uint8Array(v.rows * 2);
    imbalanceFlags(v, o, flags);
    for (const s of stacksOf(flags, v.rows, o.stackRows)) {
      const lowTick = v.lowTick + s.low * v.rowTicks;
      const highTick = v.lowTick + (s.high + 1) * v.rowTicks;
      const session = bars.session(i);
      let j = i + 1;
      let stopped = false;
      for (; j <= last; j++) {
        if (bars.session(j) - session >= ZONE_SESSIONS) break;
        if (bars.lowTick(j) < highTick && bars.highTick(j) >= lowTick) {
          stopped = true;
          break;
        }
      }
      const expired = !stopped && j <= last;
      out.push({
        side: s.side,
        lowTick,
        highTick,
        from: i,
        to: stopped ? j : expired ? j - 1 : last,
        open: !stopped && !expired,
      });
    }
  }
  return out;
}

export function withForming(closed: readonly Zone[], bars: ZoneBars, i: number, o: ImbalanceOptions): Zone[] {
  const out: Zone[] = [];
  const low = bars.lowTick(i);
  const high = bars.highTick(i);
  const session = bars.session(i);
  for (const z of closed) {
    if (!z.open) {
      out.push(z);
      continue;
    }
    if (session - bars.session(z.from) >= ZONE_SESSIONS) out.push({ ...z, to: i - 1, open: false });
    else if (low < z.highTick && high >= z.lowTick) out.push({ ...z, to: i, open: false });
    else out.push({ ...z, to: i });
  }
  for (const z of stackedZones(bars, i, i, o)) out.push(z);
  return out;
}
