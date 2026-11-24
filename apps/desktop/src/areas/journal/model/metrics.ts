import type { Bucket } from '@tessera/protocol';
import { formatMoney } from '@tessera/ui';
import { pct, rLabel } from './format.ts';

export type BucketMetric = 'net' | 'avg' | 'winRate' | 'expectancy' | 'avgR' | 'n';

export const METRICS: readonly { value: BucketMetric; label: string }[] = [
  { value: 'net', label: 'Net P&L' },
  { value: 'avg', label: 'Per trade' },
  { value: 'expectancy', label: 'Expectancy' },
  { value: 'winRate', label: 'Win rate' },
  { value: 'avgR', label: 'Average R' },
  { value: 'n', label: 'Trades' },
];

export const SMALL_N = 20;

export function metricValue(b: Bucket, m: BucketMetric): number | null {
  switch (m) {
    case 'net':
      return b.net;
    case 'avg':
      return b.avg;
    case 'expectancy':
      return b.expectancy;
    case 'winRate':
      return b.winRate;
    case 'avgR':
      return b.avgR;
    case 'n':
      return b.n;
  }
}

export function metricText(v: number | null, m: BucketMetric): string {
  if (v === null) return '—';
  if (m === 'winRate') return pct(v);
  if (m === 'avgR') return rLabel(v);
  if (m === 'n') return String(v);
  return formatMoney(v, { signed: true });
}
