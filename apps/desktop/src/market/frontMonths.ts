import { isSessionTimeframe, normalizeEpochMs, type ContractRun, type Timeframe } from '@tessera/protocol';
import { displaySymbol } from './instruments.ts';

export interface ContractSpan {
  instrument: string;
  from: number;
  to: number;
}

export const asksFrontMonths = (tf: Timeframe): boolean => isSessionTimeframe(tf);

export function contractSpans(runs: readonly ContractRun[] | undefined): ContractSpan[] {
  return (runs ?? []).map((r) => ({
    instrument: r.instrument,
    from: normalizeEpochMs(r.from),
    to: normalizeEpochMs(r.to),
  }));
}

export function withSpans(held: readonly ContractSpan[], more: readonly ContractSpan[]): ContractSpan[] {
  const seen = new Set<string>();
  return [...held, ...more]
    .filter((s) => {
      const key = `${s.instrument}|${String(s.from)}|${String(s.to)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.from - b.from);
}

export function earlierContractAt(spans: readonly ContractSpan[], charted: string | null, t: number): string | null {
  const span = spans.find((s) => s.instrument !== charted && s.from <= t && t <= s.to);
  return span ? displaySymbol(span.instrument) : null;
}

export function frontMonthsNote(spans: readonly ContractSpan[], charted: string | null): string | null {
  const oldest = spans.find((s) => s.instrument !== charted);
  return oldest ? `Front months from ${displaySymbol(oldest.instrument)}, unadjusted` : null;
}
