import type { ConnectionInfo, Instrument, MarketCapabilities, TradingAccount } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import type { ConnectionListing } from '../src/areas/markets/model.ts';
import {
  accountsFor,
  exchangeOf,
  exchangeOfId,
  exchangeRows,
  feederOf,
  marketsWords,
  readRoutes,
  routedAccount,
  withRoute,
} from '../src/markets/routes.ts';
import { connectionInfo, providerHealth } from './support/providers.ts';

const inst = (id: string, exchange: string, root: string | null = null): Instrument => ({
  id,
  symbol: id.split('.')[0]!,
  name: id,
  assetClass: 'future',
  exchange,
  currency: 'USD',
  root,
  expiry: null,
  isFront: true,
  tradable: true,
});

const listing = (id: string, instruments: Instrument[]): ConnectionListing => ({
  id,
  name: id,
  feedsDesk: false,
  error: null,
  instruments,
});

const conn = (id: string, market = true): ConnectionInfo =>
  connectionInfo(providerHealth({ providerId: id }), { market: market ? ({} as MarketCapabilities) : null });

const account = (id: string, connectionId: string): TradingAccount =>
  ({ id, displayName: id, connectionId }) as unknown as TradingAccount;

const apex = listing('rithmic-apex', [
  inst('NQZ6.CME-RITHMIC', 'CME', 'NQ'),
  inst('ESZ6.CME-RITHMIC', 'CME', 'ES'),
  inst('ZNZ6.CBOT-RITHMIC', 'CBOT', 'ZN'),
  inst('GCZ6.COMEX-RITHMIC', 'COMEX', 'GC'),
]);
const bulenox = listing('rithmic-bulenox', [
  inst('NQZ6.CME-RITHMIC', 'CME', 'NQ'),
  inst('GCZ6.COMEX-RITHMIC', 'COMEX', 'GC'),
  inst('CLZ6.NYMEX-RITHMIC', 'NYMEX', 'CL'),
]);
const topstep = listing('rithmic-topstep', [
  inst('NQZ6.CME', 'CME', 'NQ'),
  inst('FDAX', 'EUREX', null),
  inst('FESXZ6.EUREX', 'EUREX', 'FESX'),
]);

describe('routes by exchange', () => {
  it('reads only upper-case exchanges to ids', () => {
    expect(
      readRoutes({ comex: 'rithmic-bulenox', CME: '', NYMEX: 7, 'bad key!': 'x', 'ICE US': 'rithmic-topstep' }),
    ).toEqual({
      COMEX: 'rithmic-bulenox',
      'ICE US': 'rithmic-topstep',
    });
    expect(readRoutes(null)).toEqual({});
    expect(readRoutes(['CME'])).toEqual({});
  });

  it('routes an exchange, and takes it back to the default', () => {
    const r = withRoute({ CME: 'rithmic-apex' }, 'COMEX', 'rithmic-bulenox');
    expect(r).toEqual({ CME: 'rithmic-apex', COMEX: 'rithmic-bulenox' });
    expect(withRoute(r, 'CME', null)).toEqual({ COMEX: 'rithmic-bulenox' });
  });

  it('finds an instrument’s exchange from its id, else its listing', () => {
    expect(exchangeOfId('NQZ6.CME-RITHMIC')).toBe('CME');
    expect(exchangeOfId('NQZ6.CME')).toBe('CME');
    expect(exchangeOfId('BTC-USD.COINBASE')).toBe('COINBASE');
    expect(exchangeOfId('FDAX')).toBeNull();
    expect(exchangeOf('FDAX', [topstep])).toBe('EUREX');
    expect(routedAccount({ CME: 'APEX-1' }, exchangeOfId('NQZ6.CME-RITHMIC'))).toBe('APEX-1');
    expect(routedAccount({ CME: 'APEX-1' }, null)).toBeNull();
  });

  it('lists every exchange the connections list, CME Group’s first, and one routed that none lists now', () => {
    const rows = exchangeRows([topstep, apex, bulenox], { ICE: 'rithmic-off' }, { COMEX: 'BX-1' });
    expect(rows.map((r) => r.exchange)).toEqual(['CME', 'CBOT', 'NYMEX', 'COMEX', 'EUREX', 'ICE']);
    const comex = rows.find((r) => r.exchange === 'COMEX')!;
    expect(comex).toMatchObject({ markets: ['GC'], connections: ['rithmic-apex', 'rithmic-bulenox'], account: 'BX-1' });
    expect(rows.find((r) => r.exchange === 'CME')!.connections).toEqual([
      'rithmic-topstep',
      'rithmic-apex',
      'rithmic-bulenox',
    ]);
    expect(rows.find((r) => r.exchange === 'EUREX')!.markets).toEqual(['FDAX', 'FESX']);
    expect(rows.find((r) => r.exchange === 'ICE')).toMatchObject({ markets: [], data: 'rithmic-off' });
  });

  it('says which connection feeds an exchange now, as the runtime routes it', () => {
    const infos = [conn('rithmic-apex'), conn('rithmic-bulenox'), conn('rithmic-topstep')];
    const listings = [apex, bulenox, topstep];
    expect(feederOf('COMEX', { COMEX: 'rithmic-bulenox' }, infos, 'rithmic-apex', listings)).toBe('rithmic-bulenox');
    expect(feederOf('CME', {}, infos, 'rithmic-apex', listings)).toBe('rithmic-apex');
    expect(feederOf('EUREX', {}, infos, 'rithmic-apex', listings)).toBe('rithmic-topstep');
    expect(
      feederOf(
        'COMEX',
        { COMEX: 'rithmic-bulenox' },
        [conn('rithmic-apex'), conn('rithmic-bulenox', false)],
        'rithmic-apex',
        listings,
      ),
    ).toBe('rithmic-apex');
  });

  it('offers an exchange the accounts that can trade it: paper, and those of a connection listing it', () => {
    const accounts = [account('PAPER', 'paper'), account('APEX-1', 'rithmic-apex'), account('BX-1', 'rithmic-bulenox')];
    const nymex = exchangeRows([apex, bulenox], {}, {}).find((r) => r.exchange === 'NYMEX')!;
    expect(accountsFor(accounts, nymex, [apex, bulenox]).map((a) => a.id)).toEqual(['PAPER', 'BX-1']);
    expect(accountsFor(accounts, { ...nymex, account: 'APEX-1' }, [apex, bulenox]).map((a) => a.id)).toEqual([
      'PAPER',
      'APEX-1',
      'BX-1',
    ]);
  });

  it('names a few markets and how many more', () => {
    expect(marketsWords(['NQ', 'ES'])).toBe('NQ, ES');
    expect(marketsWords(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).toBe('A, B, C, D, E, F and 2 more');
    expect(marketsWords([])).toBe('Nothing listed now');
  });
});
