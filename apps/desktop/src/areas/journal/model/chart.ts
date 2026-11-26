import type { Timeframe } from '@tessera/protocol';

export function autoTimeframe(holdSecs: number | null): Timeframe {
  const m = (holdSecs ?? 0) / 60;
  if (m <= 40) return '1m';
  if (m <= 180) return '5m';
  if (m <= 480) return '15m';
  return '1h';
}

export function cumulative(values: readonly number[]): number[] {
  let s = 0;
  return values.map((v) => (s += v));
}
