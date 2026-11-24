export const MINUS = '−';

const fixedCache = new Map<string, Intl.NumberFormat>();

function fmt(minFrac: number, maxFrac: number, grouping: boolean): Intl.NumberFormat {
  const key = `${String(minFrac)}:${String(maxFrac)}:${grouping ? 'g' : 'n'}`;
  let f = fixedCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
      useGrouping: grouping,
    });
    fixedCache.set(key, f);
  }
  return f;
}

function clampDecimals(d: number): number {
  return Math.min(10, Math.max(0, Math.floor(d)));
}

function roundedIsZero(value: number, decimals: number): boolean {
  return Number(Math.abs(value).toFixed(clampDecimals(decimals))) === 0;
}

export function formatPrice(value: number | null | undefined, precision: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const d = clampDecimals(precision);
  const body = fmt(d, d, true).format(Math.abs(value));
  return value < 0 && !roundedIsZero(value, d) ? `${MINUS}${body}` : body;
}

export function formatSigned(value: number | null | undefined, decimals: number, grouping = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const d = clampDecimals(decimals);
  const body = fmt(d, d, grouping).format(Math.abs(value));
  if (roundedIsZero(value, d)) return body;
  return `${value > 0 ? '+' : MINUS}${body}`;
}

export interface MoneyOptions {
  signed?: boolean;
  currency?: string | undefined;
  compact?: boolean;
}

export interface MoneyAmount {
  amount: number;
  currency: string;
}

const CENTS = 2;

export function formatMoney(value: number | MoneyAmount | null | undefined, options: MoneyOptions = {}): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : value.amount;
  if (!Number.isFinite(n)) return '—';
  const currency = (typeof value === 'number' ? undefined : value.currency) ?? options.currency ?? 'USD';
  const decimals = options.compact ? 0 : CENTS;
  const body = options.compact ? compactBody(Math.abs(n)) : fmt(CENTS, CENTS, true).format(Math.abs(n));
  const amount = currency === 'USD' ? `$${body}` : `${body} ${currency}`;
  if (roundedIsZero(n, decimals)) return amount;
  if (n < 0) return `${MINUS}${amount}`;
  return options.signed ? `+${amount}` : amount;
}

function compactBody(abs: number): string {
  if (abs >= 100_000) return `${fmt(0, 0, true).format(abs / 1000)}k`;
  if (abs >= 10_000) return `${fmt(1, 1, true).format(abs / 1000)}k`;
  return fmt(0, 0, true).format(abs);
}

export function formatPercent(
  value: number | null | undefined,
  decimals = 2,
  options: { signed?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const signed = options.signed ?? true;
  const s = signed ? formatSigned(value, decimals, true) : formatPrice(value, decimals);
  return `${s}%`;
}

export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const a = Math.abs(value);
  const sign = value < 0 ? MINUS : '';
  if (a >= 1e9) return `${sign}${trimZero((a / 1e9).toFixed(a >= 1e10 ? 1 : 2))}B`;
  if (a >= 1e6) return `${sign}${trimZero((a / 1e6).toFixed(a >= 1e7 ? 1 : 2))}M`;
  if (a >= 1e3) return `${sign}${String(Math.round(a / 1e3))}K`;
  return `${sign}${String(Math.round(a))}`;
}

function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const body = fmt(0, 0, true).format(Math.abs(Math.round(value)));
  return value <= -0.5 ? `${MINUS}${body}` : body;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(m)}m ${String(s).padStart(2, '0')}s`;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${String(total)}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  if (h > 0) return `${String(h)}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m)}:${ss}`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${mm}:${ss}` : `${mm}:${ss}`;
}

const clockCache = new Map<string, Intl.DateTimeFormat>();

export function formatClock(epochMs: number, timeZone: string, withSeconds = true): string {
  const key = `${timeZone}:${withSeconds ? 's' : 'm'}`;
  let f = clockCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hourCycle: 'h23',
    });
    clockCache.set(key, f);
  }
  return f.format(epochMs);
}

export function precisionFromTick(tick: number): number {
  if (!Number.isFinite(tick) || tick <= 0) return 2;
  for (let d = 0; d <= 10; d++) {
    if (Math.abs(Math.round(tick * 10 ** d) - tick * 10 ** d) < 1e-9) return d;
  }
  return 10;
}

export type Tone = 'up' | 'down' | 'flat';

export function toneOf(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}
