import type { ConnectionInfo, ContractForOutput, ContractSpec } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { tradedWords } from '../src/analyst/orderCheck.ts';
import { beginPlacement, placeAt, ticketPlaceBase } from '../src/chart/placement.ts';
import { contractWords, tradedContract } from '../src/market/contracts.ts';
import { dataConnections, shownDataSource } from '../src/market/dataFrom.ts';
import * as families from '../src/market/families.ts';
import { familyOf, rootFor, siblingOf } from '../src/market/families.ts';
import { stripFor, type StripInput } from '../src/orderflow/dom/ladderModel.ts';
import { mathOf } from '../src/shell/tradeContext.ts';

const MNQ = {
  instrument: 'X7.FAKE',
  root: 'MNQ',
  tickSize: 0.25,
  tickValue: { amount: 0.5, currency: 'USD' },
  multiplier: 2,
  priceDecimals: 2,
  expiry: '2026-12-18',
  microOf: 'NQ',
} as unknown as ContractSpec;

const NQ = {
  ...MNQ,
  instrument: 'X1.FAKE',
  root: 'NQ',
  tickValue: { amount: 5, currency: 'USD' },
  microOf: null,
} as unknown as ContractSpec;

function answer(root: 'NQ' | 'MNQ' | 'MES'): ContractForOutput {
  const base = {
    accountId: 'fake-eval-1',
    account: 'TEST-000001 (Fake · Rithmic)',
    wanted: { exchange: 'CME', root, expiry: '2026-12' },
  };
  if (root === 'MES')
    return { ...base, instrument: null, spec: null, refused: 'TEST-000001 (Fake · Rithmic) has no MES Dec 2026' };
  const spec = root === 'MNQ' ? MNQ : NQ;
  return { ...base, instrument: { id: spec.instrument } as never, spec, refused: null };
}

describe('the contract an account trades', () => {
  it('an NQ chart’s micro is the id the account’s connection returned, never one made from the chart’s', () => {
    const family = familyOf(NQ)!;
    const root = rootFor('micro', family)!;
    expect(root).toBe('MNQ');
    const traded = tradedContract(answer(root as 'MNQ'));
    expect(traded).toMatchObject({ instrument: 'X7.FAKE', refused: null, meant: 'MNQ Dec 2026' });
    const math = mathOf(traded.spec, traded.instrument)!;
    const base = ticketPlaceBase({
      accountId: 'fake-eval-1',
      environment: 'eval',
      contract: { instrument: traded.instrument!, symbol: 'MNQ Z6', math },
      side: 'buy',
      kind: 'market',
      ticket: { qty: 2, sizing: 'qty', risk: 0 },
      stopTicks: null,
      targetTicks: null,
      tile: { layoutId: 'main', tileId: 'chart-1' },
    });
    const step = placeAt(beginPlacement(base), 21000, { bid: 21000, ask: 21000.25, last: 21000 }, false);
    expect(step.kind).toBe('send');
    if (step.kind === 'send') expect(step.input.instrument).toBe('X7.FAKE');
  });

  it('a sibling the connection does not list is refused in words naming the account and the contract', () => {
    expect(tradedContract(answer('MES'))).toEqual({
      instrument: null,
      spec: null,
      meant: 'MES Dec 2026',
      refused: 'TEST-000001 (Fake · Rithmic) has no MES Dec 2026',
      pending: false,
    });
    expect(tradedContract(undefined)).toMatchObject({ instrument: null, refused: null, pending: true });
    expect(tradedContract(null)).toMatchObject({ instrument: null, refused: null, pending: false });
    expect(contractWords({ exchange: 'CME', root: 'NQ', expiry: null })).toBe('NQ');
  });

  it('no traded id is built from strings: the account’s answer is its only producer', () => {
    expect(Object.keys(families).sort()).toEqual(
      ['FAMILIES', 'familyOf', 'mirrors', 'readExecuteAs', 'rootFor', 'siblingOf'].sort(),
    );
    expect(siblingOf(familyOf(NQ)!)).toEqual({ as: 'micro', root: 'MNQ' });
  });

  it('the analyst is asked about the sibling in words, never an id', () => {
    expect(tradedWords('chart', 'NQZ6.CME')).toBe('NQ Z6');
    expect(tradedWords('micro', 'NQZ6.CME-RITHMIC')).toBe('MNQ on the NQ Z6 chart');
    expect(tradedWords('full', 'MESZ6.CME')).toBe('ES on the MES Z6 chart');
    expect(tradedWords('micro', 'MESZ6.CME')).toBe('MES Z6');
  });
});

describe('market data from', () => {
  const conn = (id: string, displayName: string, market = true): ConnectionInfo =>
    ({
      id,
      kind: market ? 'market_data' : 'intelligence',
      displayName,
      market: market ? {} : null,
      intel: null,
      broker: null,
      accountOrderEntry: null,
      health: {},
    }) as unknown as ConnectionInfo;
  const infos = [
    conn('rithmic-apex', 'Apex · Rithmic'),
    conn('rithmic-bulenox', 'Bulenox · Rithmic'),
    conn('zeta', 'Zeta', false),
  ];

  it('offers every connection with market data', () => {
    expect(dataConnections(infos).map((c) => [c.id, c.displayName])).toEqual([
      ['rithmic-apex', 'Apex · Rithmic'],
      ['rithmic-bulenox', 'Bulenox · Rithmic'],
    ]);
  });

  it('shows the choice in force: the stored one while connected, else the one the runtime uses now', () => {
    expect(shownDataSource('rithmic-bulenox', infos, 'rithmic-bulenox')).toBe('rithmic-bulenox');
    expect(shownDataSource('auto', infos, 'rithmic-apex')).toBe('rithmic-apex');
    expect(shownDataSource('rithmic-gone', infos, 'rithmic-apex')).toBe('rithmic-apex');
    expect(shownDataSource(undefined, infos, null)).toBe('rithmic-apex');
    expect(shownDataSource('auto', [], null)).toBeNull();
  });

  it('the DOM says once why it sends nothing for its contract', () => {
    const base: StripInput = {
      now: 10_000,
      placing: null,
      flash: null,
      feed: { kind: 'live' },
      account: { kind: 'refused', why: 'TEST-000001 (Fake · Rithmic) has no MES Dec 2026' },
      hover: null,
      decimals: 2,
    };
    expect(stripFor(base)).toMatchObject({
      left: 'TEST-000001 (Fake · Rithmic) has no MES Dec 2026',
      tone: 'plain',
      action: null,
    });
  });
});
