import type { Emotion, ExitReason, Side, TradeResult } from '@tessera/protocol';
import { MINUS } from '@tessera/ui';
import { displayZone } from '../../../state/timeZone.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

function utcDay(date: string): Date {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d));
}

export function dayLabel(date: string): string {
  const t = utcDay(date);
  return `${WEEKDAYS[t.getUTCDay()]!} ${String(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]!}`;
}

export function longDate(date: string): string {
  const t = utcDay(date);
  return `${WEEKDAYS_LONG[t.getUTCDay()]!} ${String(t.getUTCDate())} ${MONTHS_LONG[t.getUTCMonth()]!} ${String(t.getUTCFullYear())}`;
}

export function monthLabel(month: string): string {
  const { y, m } = parseDate(`${month}-01`);
  return `${MONTHS_LONG[m - 1]!} ${String(y)}`;
}

export function shortDate(date: string): string {
  const t = utcDay(date);
  return `${String(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]!}`;
}

export function nsToMs(ns: number): number {
  return Math.round(ns / 1e6);
}

const clockFmt = new Map<string, Intl.DateTimeFormat>();

export function clock(ns: number, tz: string = displayZone()): string {
  let f = clockFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
    clockFmt.set(tz, f);
  }
  return f.format(new Date(nsToMs(ns)));
}

export function todayIn(tz: string = displayZone(), now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now))
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year ?? '1970'}-${parts.month ?? '01'}-${parts.day ?? '01'}`;
}

export function holdLabel(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '—';
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(h / 24))}d ${String(h % 24)}h`;
}

export function sideWord(side: Side): string {
  return side === 'buy' ? 'Long' : 'Short';
}

export function resultWord(r: TradeResult): string {
  switch (r) {
    case 'target':
      return 'Target';
    case 'stop':
      return 'Stop';
    case 'trailed':
      return 'Trailed stop';
    case 'breakeven':
      return 'Breakeven stop';
    case 'manual':
      return 'Manual';
    case 'open':
      return 'Open';
  }
}

export const EMOTIONS: readonly Emotion[] = [
  'confident',
  'neutral',
  'anxious',
  'fearful',
  'greedy',
  'frustrated',
  'excited',
];

export function emotionWord(e: Emotion): string {
  return e.charAt(0).toUpperCase() + e.slice(1);
}

export const EXIT_REASONS: readonly ExitReason[] = [
  'take_profit',
  'stop_loss',
  'trailing_stop',
  'breakeven',
  'manual',
  'time_based',
];

export function exitReasonWord(r: ExitReason): string {
  switch (r) {
    case 'take_profit':
      return 'Target';
    case 'stop_loss':
      return 'Stop';
    case 'trailing_stop':
      return 'Trailed stop';
    case 'breakeven':
      return 'Breakeven stop';
    case 'manual':
      return 'By hand';
    case 'time_based':
      return 'Time';
  }
}

export function rLabel(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  const body = Math.abs(r).toFixed(2);
  if (Number(body) === 0) return '0.00R';
  return `${r > 0 ? '+' : MINUS}${body}R`;
}

export function pct(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(decimals)}%`;
}

export function tone(v: number | null | undefined): 'up' | 'down' | undefined {
  if (v === null || v === undefined || !Number.isFinite(v) || Math.abs(v) < 0.005) return undefined;
  return v > 0 ? 'up' : 'down';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
