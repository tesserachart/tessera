export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];

export function advance(cursor: number, realMs: number, speed: number): number {
  return cursor + realMs * 60 * speed;
}

export function shownBars(starts: readonly number[], cursor: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function stepBar(starts: readonly number[], cursor: number, dir: 1 | -1): number {
  if (!starts.length) return cursor;
  const n = shownBars(starts, cursor);
  const i = Math.max(1, Math.min(starts.length, n + dir));
  return starts[i - 1]!;
}

export function replayStart(starts: readonly number[], entryMs: number, lead = 15): number {
  if (!starts.length) return entryMs;
  const at = Math.max(0, shownBars(starts, entryMs) - 1 - lead);
  return starts[at]!;
}
