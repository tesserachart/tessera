import { useInstrumentInfo } from '../../chart/identity.ts';
import { useRowQuote, useRowSpec } from '../../markets/rowData.ts';
import { useMarketSessions } from '../../markets/sessions.ts';
import type { MarketRow } from './model.ts';

export interface DetailSubject {
  id: string;
  row: MarketRow | null;
}

export function useMarketFacts(subject: DetailSubject | null, nowMs: number) {
  const id = subject?.id ?? '';
  const row = subject?.row ?? null;
  const { spec, resolved, missing } = useRowSpec(id, !!row?.instrument, subject !== null);
  const sessions = useMarketSessions(spec ? (resolved ?? id) : null, nowMs);
  const info = useInstrumentInfo(subject && !row?.instrument ? id : null, resolved);
  const q = useRowQuote(resolved ?? (row?.instrument ? id : null), true);
  return { spec, resolved, missing, sessions, info, q };
}
