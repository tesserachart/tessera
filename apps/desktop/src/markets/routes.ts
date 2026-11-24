import type { ConnectionInfo, TradingAccount } from '@tessera/protocol';
import type { ConnectionListing } from '../areas/markets/model.ts';

export const DATA_BY_EXCHANGE = 'market.dataByExchange';
export const ACCOUNT_BY_EXCHANGE = 'trade.accountByExchange';

export type ExchangeRoutes = Readonly<Record<string, string>>;

const EXCHANGE = /^[A-Z0-9][A-Z0-9 ._-]{0,23}$/;

export function readRoutes(v: unknown): ExchangeRoutes {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
    const ex = k.trim().toUpperCase();
    if (EXCHANGE.test(ex) && typeof id === 'string' && id.trim() !== '') out[ex] = id;
  }
  return out;
}

export function withRoute(routes: ExchangeRoutes, exchange: string, id: string | null): Record<string, string> {
  const { [exchange]: _was, ...rest } = routes;
  return id === null ? rest : { ...rest, [exchange]: id };
}

export function exchangeOfId(id: string): string | null {
  const dot = id.lastIndexOf('.');
  if (dot < 0) return null;
  const venue =
    id
      .slice(dot + 1)
      .split('-')[0]
      ?.toUpperCase() ?? '';
  return EXCHANGE.test(venue) ? venue : null;
}

export function exchangeOf(id: string, listings: readonly ConnectionListing[] = []): string | null {
  for (const l of listings) {
    const hit = l.instruments.find((i) => i.id === id);
    if (hit?.exchange) return hit.exchange.toUpperCase();
  }
  return exchangeOfId(id);
}

export function routedAccount(routes: ExchangeRoutes, exchange: string | null): string | null {
  return exchange ? (routes[exchange] ?? null) : null;
}

export function feederOf(
  exchange: string,
  routes: ExchangeRoutes,
  infos: readonly ConnectionInfo[],
  now: string | null,
  listings: readonly ConnectionListing[],
): string | null {
  const own = routes[exchange];
  if (own && infos.some((c) => c.id === own && c.market !== null && c.kind === 'market_data')) return own;
  const lists = (l: ConnectionListing) => l.instruments.some((i) => i.exchange.toUpperCase() === exchange);
  if (now && listings.some((l) => l.id === now && lists(l))) return now;
  return listings.find(lists)?.id ?? now;
}

const FIRST = ['CME', 'CBOT', 'NYMEX', 'COMEX'];

export interface ExchangeRow {
  exchange: string;
  markets: string[];
  connections: string[];
  data: string | null;
  account: string | null;
}

export function exchangeRows(
  listings: readonly ConnectionListing[],
  data: ExchangeRoutes,
  accounts: ExchangeRoutes,
): ExchangeRow[] {
  const by = new Map<string, { markets: string[]; connections: string[] }>();
  const at = (ex: string) => {
    let row = by.get(ex);
    if (!row) by.set(ex, (row = { markets: [], connections: [] }));
    return row;
  };
  for (const l of listings)
    for (const i of l.instruments) {
      const ex = i.exchange.trim().toUpperCase();
      if (!ex) continue;
      const row = at(ex);
      const name = i.root ?? i.symbol;
      if (!row.markets.includes(name)) row.markets.push(name);
      if (!row.connections.includes(l.id)) row.connections.push(l.id);
    }
  for (const ex of [...Object.keys(data), ...Object.keys(accounts)]) at(ex);
  const rank = (ex: string) => {
    const i = FIRST.indexOf(ex);
    return i < 0 ? FIRST.length : i;
  };
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([exchange, r]) => ({
      exchange,
      markets: r.markets,
      connections: r.connections,
      data: data[exchange] ?? null,
      account: accounts[exchange] ?? null,
    }));
}

export function marketsWords(markets: readonly string[], shown = 6): string {
  if (markets.length === 0) return 'Nothing listed now';
  const head = markets.slice(0, shown).join(', ');
  const more = markets.length - shown;
  return more > 0 ? `${head} and ${String(more)} more` : head;
}

export function accountsFor(
  accounts: readonly TradingAccount[],
  row: Pick<ExchangeRow, 'connections' | 'account'>,
  listings: readonly ConnectionListing[],
): TradingAccount[] {
  return accounts.filter((a) => {
    const c = a.connectionId;
    if (a.id === row.account || c === 'paper' || row.connections.includes(c)) return true;
    const listing = listings.find((l) => l.id === c);
    return !listing || listing.instruments.length === 0;
  });
}
