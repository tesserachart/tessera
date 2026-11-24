import type { SeriesStore, DataChange } from './store.ts';
import { ZonedClock } from './tz.ts';
import type { SessionOptions } from './types.ts';

export const Weight = {
  None: 0,
  Min1: 1,
  Min2: 2,
  Min5: 3,
  Min10: 4,
  Min15: 5,
  Min30: 6,
  Hour1: 7,
  Hour2: 8,
  Hour3: 9,
  Hour4: 10,
  Hour6: 11,
  Hour12: 12,
  Day: 13,
  Week: 14,
  Month: 15,
  Year: 16,
} as const;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const WEIGHT_MS: readonly number[] = [
  0,
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  4 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
  30 * DAY,
  365 * DAY,
];

const HOUR_STEPS: readonly [number, number][] = [
  [12, Weight.Hour12],
  [6, Weight.Hour6],
  [4, Weight.Hour4],
  [3, Weight.Hour3],
  [2, Weight.Hour2],
  [1, Weight.Hour1],
];
const MINUTE_STEPS: readonly [number, number][] = [
  [30, Weight.Min30],
  [15, Weight.Min15],
  [10, Weight.Min10],
  [5, Weight.Min5],
  [2, Weight.Min2],
  [1, Weight.Min1],
];

export const DEFAULT_SESSIONS: SessionOptions = {
  mode: 'collapse',
  timezone: 'UTC',
  dayStartMinutes: 0,
};

const DEFAULT_MAX_GAP = 3 * HOUR;

export class SessionModel {
  readonly options: SessionOptions;
  readonly clock: ZonedClock;
  readonly dayClock: ZonedClock;
  readonly timeframeMs: number;
  slot = new Float64Array(0);
  day = new Int32Array(0);
  weight = new Uint8Array(0);
  brk = new Uint8Array(0);
  private n = 0;

  constructor(options: SessionOptions, timeframeMs: number) {
    this.options = options;
    this.timeframeMs = Math.max(1, timeframeMs);
    this.clock = new ZonedClock(options.timezone);
    const dayZone = options.dayStartZone ?? options.timezone;
    this.dayClock = dayZone === options.timezone ? this.clock : new ZonedClock(dayZone);
  }

  get length(): number {
    return this.n;
  }

  get lastSlot(): number {
    return this.n > 0 ? this.slot[this.n - 1]! : 0;
  }

  private ensure(cap: number): void {
    if (this.slot.length >= cap) return;
    let c = Math.max(16, this.slot.length);
    while (c < cap) c *= 2;
    const s = new Float64Array(c);
    s.set(this.slot.subarray(0, this.n));
    const d = new Int32Array(c);
    d.set(this.day.subarray(0, this.n));
    const w = new Uint8Array(c);
    w.set(this.weight.subarray(0, this.n));
    const b = new Uint8Array(c);
    b.set(this.brk.subarray(0, this.n));
    this.slot = s;
    this.day = d;
    this.weight = w;
    this.brk = b;
  }

  apply(store: SeriesStore, change: DataChange): void {
    const n = store.length;
    this.ensure(n);
    const from = change.kind === 'set' ? 0 : Math.max(0, Math.min(change.from, this.n));
    const { dayStartMinutes } = this.options;
    const continuous = this.options.mode === 'continuous';
    const maxGap = this.options.maxGapMs ?? DEFAULT_MAX_GAP;
    const time = store.time;
    for (let i = from; i < n; i++) {
      const t = time[i]!;
      const day = this.dayClock.tradingDay(t, dayStartMinutes);
      this.day[i] = day;
      if (i === 0) {
        this.slot[0] = 0;
        this.weight[0] = Weight.Day;
        this.brk[0] = 0;
        continue;
      }
      const tp = time[i - 1]!;
      const dp = this.day[i - 1]!;
      const gap = t - tp;
      let s = 1;
      let brk = day !== dp ? 1 : 0;
      if (continuous) {
        if (gap > maxGap) brk = 1;
        else s = Math.max(1, Math.round(gap / this.timeframeMs));
      }
      this.slot[i] = this.slot[i - 1]! + s;
      this.brk[i] = brk;
      this.weight[i] = this.weightOf(tp, t, dp, day);
    }
    this.n = n;
  }

  private weightOf(tPrev: number, t: number, dayPrev: number, day: number): number {
    if (day !== dayPrev) {
      if (Math.floor(day / 10_000) !== Math.floor(dayPrev / 10_000)) return Weight.Year;
      if (Math.floor(day / 100) !== Math.floor(dayPrev / 100)) return Weight.Month;
      return startsNewWeek(dayPrev, day) ? Weight.Week : Weight.Day;
    }
    const lp = this.clock.toLocalMs(tPrev);
    const lc = this.clock.toLocalMs(t);
    for (const [h, w] of HOUR_STEPS) {
      if (Math.floor(lc / (h * HOUR)) !== Math.floor(lp / (h * HOUR))) return w;
    }
    for (const [m, w] of MINUTE_STEPS) {
      if (Math.floor(lc / (m * MIN)) !== Math.floor(lp / (m * MIN))) return w;
    }
    return Weight.None;
  }

  indexOfSlot(slot: number): number {
    const n = this.n;
    if (n === 0) return -1;
    if (this.options.mode === 'collapse') return Math.min(n - 1, Math.max(0, Math.round(slot)));
    let lo = 0;
    let hi = n - 1;
    if (slot <= this.slot[0]!) return 0;
    if (slot >= this.slot[hi]!) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (this.slot[mid]! <= slot) lo = mid;
      else hi = mid;
    }
    return slot - this.slot[lo]! <= this.slot[hi]! - slot ? lo : hi;
  }

  firstIndexFrom(slot: number): number {
    const n = this.n;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.slot[mid]! < slot) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  lastIndexTo(slot: number): number {
    return this.firstIndexFrom(slot + 1e-9) - 1;
  }
}

export function opensPeriod(period: string, dayPrev: number, day: number): boolean {
  if (day === dayPrev) return false;
  if (period === 'week') return startsNewWeek(dayPrev, day);
  if (period === 'month') return Math.floor(day / 100) !== Math.floor(dayPrev / 100);
  return true;
}

function startsNewWeek(dayPrev: number, day: number): boolean {
  const a = dayKeyToUtc(dayPrev);
  const b = dayKeyToUtc(day);
  return b - a >= 7 * DAY || mondayFirstWeekday(b) < mondayFirstWeekday(a);
}

function mondayFirstWeekday(utcMs: number): number {
  const d = new Date(utcMs).getUTCDay();
  return d === 0 ? 7 : d;
}

function dayKeyToUtc(key: number): number {
  return Date.UTC(Math.floor(key / 10_000), Math.floor((key % 10_000) / 100) - 1, key % 100);
}
