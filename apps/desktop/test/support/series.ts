import { encodeF64, type SeriesUpdate } from '@tessera/protocol';
import { ns } from './time.ts';

export type Columns = Readonly<Record<string, readonly number[] | null>>;

function wire(times: readonly number[], columns: Columns) {
  return {
    time: encodeF64(Float64Array.from(times)),
    columns: Object.entries(columns).map(([key, values]) => ({
      key,
      values: values === null ? null : encodeF64(Float64Array.from(values)),
    })),
  };
}

const BASE: Omit<SeriesUpdate, 'rev' | 'replaces' | 'time' | 'columns'> = {
  indicator: 'ema',
  version: null,
  instrument: 'QQQ',
  tf: '5m',
  objects: null,
  aggressorSource: null,
  loaded: null,
  filling: false,
  error: null,
  provider: 'mock-market',
  computeMs: 0.1,
};

export function seriesSnapshot(
  rev: number,
  times: readonly number[],
  columns: Columns,
  over: Partial<SeriesUpdate> = {},
): SeriesUpdate {
  return { ...BASE, rev, replaces: { kind: 'all' }, ...wire(times, columns), ...over };
}

export function seriesSpan(
  rev: number,
  span: readonly [from: number, to: number],
  times: readonly number[],
  columns: Columns,
  over: Partial<SeriesUpdate> = {},
): SeriesUpdate {
  return {
    ...BASE,
    rev,
    replaces: { kind: 'span', from: ns(span[0]), to: ns(span[1]) },
    ...wire(times, columns),
    ...over,
  };
}
