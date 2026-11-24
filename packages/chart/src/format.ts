import { monthName, pad2, weekdayName, type ZonedClock } from './tz.ts';
import { Weight } from './session.ts';
import type { PriceFormat } from './types.ts';

export const MINUS = '\u2212';

/** `toLocaleString` with options builds a new formatter on every call. */
const GROUPED = new Map<number, Intl.NumberFormat>();
function groupedFormat(decimals: number): Intl.NumberFormat {
  let f = GROUPED.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    GROUPED.set(decimals, f);
  }
  return f;
}

export class PriceFormatter {
  readonly precision: number;
  readonly minMove: number;

  constructor(format: PriceFormat) {
    this.precision = Math.min(10, Math.max(0, Math.floor(format.precision)));
    this.minMove = format.minMove > 0 ? format.minMove : 10 ** -this.precision;
  }

  format(price: number): string {
    if (!Number.isFinite(price)) return '—';
    const s = Math.abs(price).toFixed(this.precision);
    return price < 0 && Number(s) !== 0 ? `${MINUS}${s}` : s;
  }

  grouped(price: number): string {
    if (!Number.isFinite(price)) return '—';
    const s = groupedFormat(this.precision).format(Math.abs(price));
    return price < 0 && Number(price.toFixed(this.precision)) !== 0 ? `${MINUS}${s}` : s;
  }

  axis(price: number, step: number): string {
    if (!Number.isFinite(price)) return '—';
    const whole = Math.abs(step - Math.round(step)) < 1e-9 && Math.abs(price - Math.round(price)) < 1e-9;
    const decimals = whole ? 0 : this.precision;
    const s = groupedFormat(decimals).format(Math.abs(price));
    return price < 0 && Number(price.toFixed(decimals)) !== 0 ? `${MINUS}${s}` : s;
  }

  signed(delta: number): string {
    const s = Math.abs(delta).toFixed(this.precision);
    if (Number(s) === 0) return s;
    return `${delta > 0 ? '+' : MINUS}${s}`;
  }

  round(price: number): number {
    const t = this.minMove;
    return Math.round(price / t) * t;
  }
}

export function formatVolumeShort(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : '';
  if (a >= 1e9) return `${sign}${trimZero((a / 1e9).toFixed(a >= 1e10 ? 1 : 2))}B`;
  if (a >= 1e6) return `${sign}${trimZero((a / 1e6).toFixed(a >= 1e7 ? 1 : 2))}M`;
  if (a >= 1e3) return `${sign}${trimZero((a / 1e3).toFixed(a >= 1e4 ? 1 : 2))}K`;
  return `${sign}${String(Math.round(a))}`;
}

function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function timeLabel(
  clock: ZonedClock,
  utcMs: number,
  weight: number,
  dayKey: number,
  timeframeMs: number,
): string {
  if (weight >= Weight.Year) return String(Math.floor(dayKey / 10_000));
  if (weight >= Weight.Month) return monthName(Math.floor((dayKey % 10_000) / 100));
  if (weight >= Weight.Day) {
    const y = Math.floor(dayKey / 10_000);
    const m = Math.floor((dayKey % 10_000) / 100);
    const d = dayKey % 100;
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return timeframeMs >= 86_400_000 ? `${String(d)} ${monthName(m)}` : `${weekdayName(wd)} ${String(d)}`;
  }
  const p = clock.parts(utcMs);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function crosshairTimeLabel(clock: ZonedClock, utcMs: number, timeframeMs: number): string {
  const p = clock.parts(utcMs);
  const date = `${weekdayName(p.weekday)} ${pad2(p.day)} ${monthName(p.month1)}`;
  if (timeframeMs >= 86_400_000) return `${date} ${String(p.year)}`;
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return timeframeMs < 60_000 ? `${date} ${time}:${pad2(p.second)}` : `${date} ${time}`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${String(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
