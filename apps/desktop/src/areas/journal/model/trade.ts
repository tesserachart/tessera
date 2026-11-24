import type { JournalTrade } from '@tessera/protocol';

export function ticksPerContract(t: Pick<JournalTrade, 'ticks' | 'maxQty' | 'qty'>): number | null {
  if (t.ticks === null) return null;
  const size = Math.max(t.maxQty, t.qty);
  return size > 0 ? Math.round((t.ticks / size) * 10) / 10 : null;
}

export function roiPct(
  t: Pick<JournalTrade, 'netPnl' | 'entryPrice' | 'maxQty' | 'qty'>,
  pointValue: number,
): number | null {
  const notional = t.entryPrice * Math.max(t.maxQty, t.qty) * pointValue;
  return notional > 0 ? (t.netPnl / notional) * 100 : null;
}
