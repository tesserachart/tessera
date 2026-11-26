import { formatMoney } from '@tessera/ui';
import { scaleLinear, scaleUtc } from '@visx/scale';
import { bisector } from '@visx/vendor/d3-array';
import { zoneOffsetMs } from '../state/timeZone.ts';

export const AXIS_W = 64;
export const AXIS_H = 18;
const TIP_W = 200;
export const VALUE_TICKS = 4;
export const X_TICKS = 5;

export type ValueScale = ReturnType<typeof scaleLinear<number>>;

export function valueScale(
  values: readonly number[],
  range: [number, number],
  from: 'zero' | 'span' = 'zero',
): ValueScale {
  let lo = from === 'zero' ? 0 : Infinity;
  let hi = from === 'zero' ? 0 : -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) lo = hi = 0;
  if (hi === lo) hi = lo + 1;
  return scaleLinear<number>({ domain: [lo, hi], range, nice: VALUE_TICKS });
}

const byX = bisector((x: number) => x);

export function nearest(xs: readonly number[], x: number): number {
  return xs.length ? Math.max(0, Math.min(xs.length - 1, byX.center(xs, x))) : -1;
}

export function tipLeft(x: number, plotW: number): number {
  return Math.min(Math.max(0, x + 12), Math.max(0, plotW - TIP_W));
}

export function wallTime(ms: number, zone: string): number {
  return ms + zoneOffsetMs(zone, ms);
}

const DAY_MS = 86_400_000;
const DAY_MONTH = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const HOUR_MINUTE = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export type TimeScale = ReturnType<typeof scaleUtc<number>>;

export function wallScale(domain: readonly [number, number], range: [number, number]): TimeScale {
  return scaleUtc<number>({ domain: [new Date(domain[0]), new Date(domain[1])], range });
}

export function wallLabel(span: number): (d: Date) => string {
  const f = span >= 2 * DAY_MS ? DAY_MONTH : HOUR_MINUTE;
  return (d) => f.format(d);
}

const PALETTE_SIZE = 8;

export function paletteClass(i: number): string {
  return `gr-p${String(i % PALETTE_SIZE)}`;
}

export function money(v: number): string {
  return formatMoney(v, { signed: true, compact: true });
}
