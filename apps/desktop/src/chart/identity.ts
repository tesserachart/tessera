import type { AssetClass, Instrument } from '@tessera/protocol';
import { useHasTool, useToolValue } from '../app/tools.ts';

const VENUES: Record<string, string> = {
  NASDAQ: 'Nasdaq',
  NYSE: 'NYSE',
  ARCA: 'NYSE Arca',
  NYSEARCA: 'NYSE Arca',
  CBOE: 'Cboe',
  COINBASE: 'Coinbase',
};

export function venueLabel(exchange: string): string {
  return VENUES[exchange.toUpperCase()] ?? exchange;
}

const CLASSES: Record<AssetClass, string> = {
  equity: 'Stock',
  etf: 'ETF',
  index: 'Index',
  future: 'Future',
  crypto: 'Crypto',
  option: 'Option',
};

export function assetClassLabel(c: AssetClass): string {
  return CLASSES[c];
}

export function useInstrumentInfo(instrument: string | null, resolved: string | null): Instrument | null {
  const has = useHasTool('market.search_instruments');
  const q = useToolValue('market.search_instruments', has && !!instrument ? { query: instrument, limit: 5 } : null, {
    keepFor: Infinity,
  });
  if (!instrument) return null;
  const results = q?.results ?? [];
  return (
    results.find((r) => r.id === instrument || (resolved !== null && r.id === resolved)) ??
    results.find((r) => r.symbol.toUpperCase() === instrument.toUpperCase()) ??
    null
  );
}
