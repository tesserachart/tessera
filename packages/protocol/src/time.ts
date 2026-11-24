export function normalizeEpochMs(t: number): number {
  const a = Math.abs(t);
  if (a >= 1e17) return Math.round(t / 1e6);
  if (a >= 1e14) return Math.round(t / 1e3);
  if (a >= 1e11) return t;
  return t * 1000;
}

export function msToNs(ms: number): number {
  return ms * 1e6;
}

export function timeframeMs(tf: string): number {
  const m = /^(\d+)([smhDW])$/.exec(tf);
  if (!m) throw new RangeError(`unknown timeframe ${tf}`);
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 's':
      return n * 1_000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'D':
      return n * 86_400_000;
    default:
      return n * 7 * 86_400_000;
  }
}
