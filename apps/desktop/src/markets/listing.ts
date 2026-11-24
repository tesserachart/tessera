import type { ListInstrumentsOutput } from '@tessera/protocol';
import { failureText, useHasTool, useTool, valueOf } from '../app/tools.ts';
import type { ConnectionListing } from '../areas/markets/model.ts';

function listingsOf(out: ListInstrumentsOutput | undefined): ConnectionListing[] {
  return (out?.connections ?? []).map((c) => ({
    id: c.id,
    name: c.displayName,
    feedsDesk: c.feedsDesk,
    instruments: c.instruments,
    error: c.error ?? null,
  }));
}

export interface Listing {
  listings: ConnectionListing[];
  available: boolean;
  loading: boolean;
  error: string | null;
}

export function useListing(enabled = true): Listing {
  const available = useHasTool('market.list_instruments');
  const q = useTool('market.list_instruments', enabled && available ? {} : null, { refreshEvery: 60_000 });
  return {
    listings: listingsOf(valueOf(q)),
    available,
    loading: enabled && available && q.isPending,
    error: q.isError ? failureText(q.error) : null,
  };
}
