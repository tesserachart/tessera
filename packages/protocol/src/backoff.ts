export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: 0.5,
};

export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(options.maxDelayMs, options.initialDelayMs * options.factor ** (n - 1));
  const jitter = Math.min(1, Math.max(0, options.jitter));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(base * (1 - jitter * r));
}
