import { useConnection } from '../app/runtimeContext.ts';
import { useHasTool, useTool } from '../app/tools.ts';
import { DEFAULT_WATCHLIST, displaySymbol } from './instruments.ts';

export interface SymbolHit {
  instrument: string;
  name: string | null;
}

export interface SymbolSearch {
  hits: SymbolHit[];
  searching: boolean;
  failed: boolean;
}

export function useSymbolSearch(query: string, limit = 8, empty: readonly string[] = []): SymbolSearch {
  const has = useHasTool('market.search_instruments');
  const live = useConnection().status === 'open';
  const q = query.trim();
  const remote = useTool('market.search_instruments', has && live && q.length > 0 ? { query: q, limit } : null, {
    keepFor: 60_000,
  });
  if (has && live && q.length > 0) {
    const remoteHits = (remote.data?.results ?? []).map((m) => ({ instrument: m.id, name: m.name }));
    if (remote.isError && remoteHits.length === 0) {
      return { hits: localHits(q, limit, empty), searching: false, failed: true };
    }
    return { hits: remoteHits, searching: remote.isPending, failed: remote.isError };
  }
  return { hits: localHits(q, limit, empty), searching: false, failed: Boolean(q) && !live };
}

function localHits(q: string, limit: number, empty: readonly string[]): SymbolHit[] {
  if (!q && empty.length > 0) return empty.slice(0, limit).map((id) => ({ instrument: id, name: null }));
  const lq = q.toLowerCase();
  return DEFAULT_WATCHLIST.filter(
    (id) => !lq || id.toLowerCase().includes(lq) || displaySymbol(id).toLowerCase().includes(lq),
  )
    .slice(0, limit)
    .map((id) => ({ instrument: id, name: null }));
}

export function symbolRowName(row: { symbol: string; instrument: string; catalog: string }): string {
  return row.catalog && row.catalog !== row.symbol && row.catalog !== row.instrument ? row.catalog : '';
}
