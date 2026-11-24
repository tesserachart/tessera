import type { Timeframe } from './gen/Timeframe.ts';

export type TimeframeUnit = 's' | 'm' | 'h' | 'D';

export const TIMEFRAME_PRESETS: readonly Timeframe[] = ['1s', '15s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1D'];

export const MAX_SESSIONS = 365;

const SECONDS: Record<Exclude<TimeframeUnit, 'D'>, number> = { s: 1, m: 60, h: 3_600 };
const MAX_INTRADAY_SECONDS = 86_400;

const UNIT_WORDS: Record<string, TimeframeUnit> = {
  '': 'm',
  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'D',
  day: 'D',
  days: 'D',
};

const NOUN: Record<TimeframeUnit, string> = { s: 'second', m: 'minute', h: 'hour', D: 'day' };

function written(count: number, unit: TimeframeUnit): Timeframe {
  return (String(count) + unit) as Timeframe;
}

export function timeframeOf(count: number, unit: TimeframeUnit): Timeframe | null {
  if (!Number.isSafeInteger(count) || count < 1) return null;
  if (unit === 'D') return count <= MAX_SESSIONS ? written(count, 'D') : null;
  const seconds = count * SECONDS[unit];
  if (seconds > MAX_INTRADAY_SECONDS) return null;
  for (const u of ['h', 'm'] as const) {
    if (seconds % SECONDS[u] === 0) return written(seconds / SECONDS[u], u);
  }
  return written(seconds, 's');
}

const TEXT = /^(\d*)\s*([a-z]*)$/;

export function parseTimeframe(text: string): Timeframe | null {
  const m = TEXT.exec(text.trim().toLowerCase());
  if (!m) return null;
  const [, digits = '', word = ''] = m;
  if (digits === '' && word === '') return null;
  const unit = UNIT_WORDS[word];
  if (!unit) return null;
  return timeframeOf(digits === '' ? 1 : Number(digits), unit);
}

export function timeframeParts(tf: Timeframe): { count: number; unit: TimeframeUnit } {
  return { count: Number(tf.slice(0, -1)), unit: tf.slice(-1) as TimeframeUnit };
}

export function isSessionTimeframe(tf: Timeframe): boolean {
  return tf.endsWith('D');
}

export function timeframeWords(tf: Timeframe): string {
  const { count, unit } = timeframeParts(tf);
  return `${String(count)} ${NOUN[unit]}${count === 1 ? '' : 's'}`;
}

export function compareTimeframes(a: Timeframe, b: Timeframe): number {
  const seconds = (tf: Timeframe) => {
    const { count, unit } = timeframeParts(tf);
    return unit === 'D' ? Number.POSITIVE_INFINITY : count * SECONDS[unit];
  };
  const sa = seconds(a);
  const sb = seconds(b);
  if (sa === sb) return timeframeParts(a).count - timeframeParts(b).count;
  return sa < sb ? -1 : 1;
}
