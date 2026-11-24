import type { AccountUpdate, ContractSpec } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { describe, expect, it } from 'vitest';
import { bracketPalette, bracketTags, groupBrackets, namedTags } from '../src/chart/brackets.ts';
import { menuTrade } from '../src/chart/menuTrade.ts';
import { beginPlacement, placeAt, placementFor, ticketPlaceBase, type PlaceQuote } from '../src/chart/placement.ts';
import { chartMathOf } from '../src/chart/ticket/useTicketModel.ts';
import { tradedContract } from '../src/market/contracts.ts';
import { familyOf, mirrors, readExecuteAs, rootFor, siblingOf } from '../src/market/families.ts';
import { displaySymbol } from '../src/market/instruments.ts';
import { mathOf } from '../src/shell/tradeContext.ts';
import { readTicketSetup } from '../src/state/tickets.ts';
import { readWorkspaceTrade } from '../src/state/workspaceTrade.ts';

const spec = (instrument: string, root: string, tickValue: number, microOf: string | null = null): ContractSpec =>
  ({
    instrument,
    root,
    tickSize: 0.25,
    tickValue: { amount: tickValue, currency: 'USD' },
    multiplier: tickValue / 0.25,
    priceDecimals: 2,
    expiry: '2026-12-18',
    microOf,
  }) as unknown as ContractSpec;

const NQ = spec('NQZ6.CME', 'NQ', 5);
const MNQ = spec('MNQZ6.CME', 'MNQ', 0.5, 'NQ');

describe('contract families', () => {
  it('a full size has its micro as its sibling and a micro its full size, by root alone', () => {
    const nq = familyOf(NQ)!;
    expect(nq).toMatchObject({ full: 'NQ', micro: 'MNQ', root: 'NQ' });
    expect(siblingOf(nq)).toEqual({ as: 'micro', root: 'MNQ' });
    expect(siblingOf(familyOf(MNQ)!)).toEqual({ as: 'full', root: 'NQ' });
    const pairs: [string, string][] = [
      ['ES', 'MES'],
      ['YM', 'MYM'],
      ['RTY', 'M2K'],
      ['CL', 'MCL'],
      ['GC', 'MGC'],
    ];
    for (const [full, micro] of pairs) {
      expect(siblingOf(familyOf({ root: full, microOf: null })!).root).toBe(micro);
      expect(siblingOf(familyOf({ root: micro, microOf: full })!).root).toBe(full);
    }
    expect(displaySymbol('M2KZ6.CME')).toBe('M2K Z6');
  });

  it('the charted contract is the default, and a choice that names the charted member is the charted one', () => {
    const nq = familyOf(NQ);
    expect(rootFor('chart', nq)).toBeNull();
    expect(rootFor('micro', nq)).toBe('MNQ');
    expect(rootFor('full', nq)).toBeNull();
    expect(rootFor('micro', familyOf(MNQ))).toBeNull();
    expect(familyOf({ root: 'QQQ', microOf: null })).toBeNull();
    expect(familyOf(null)).toBeNull();
    expect(rootFor('micro', null)).toBeNull();
  });

  it('a spec whose own word disagrees with the families is no family', () => {
    expect(familyOf(MNQ)).toMatchObject({ full: 'NQ', micro: 'MNQ', root: 'MNQ' });
    expect(familyOf({ root: 'MNQ', microOf: 'ES' })).toBeNull();
    expect(familyOf({ root: 'NQ', microOf: 'MNQ' })).toBeNull();
    expect(familyOf({ root: 'MES', microOf: 'ES' })?.full).toBe('ES');
  });

  it('a sibling is traded only while it mirrors the chart: one tick and one expiry', () => {
    expect(mirrors(NQ, MNQ)).toBe(true);
    expect(mirrors(NQ, { ...MNQ, expiry: '2027-03-19' })).toBe(false);
    expect(mirrors(NQ, { ...MNQ, tickSize: 0.5 })).toBe(false);
    expect(mirrors(NQ, { ...MNQ, expiry: null })).toBe(true);
  });

  it('a stored choice reads back, and an older ticket trades the charted contract', () => {
    expect(readExecuteAs('micro')).toBe('micro');
    expect(readExecuteAs('MNQ')).toBe('chart');
    expect(readTicketSetup({ qty: 2 }).execute).toBe('chart');
    expect(readTicketSetup({ qty: 2, execute: 'micro' }).execute).toBe('micro');
    const v2 = readWorkspaceTrade({ v: 2, tickets: { 'chart-1': { qty: 3 } }, oco: {} });
    expect(v2?.tickets['chart-1']?.execute).toBe('chart');
    const v1 = readWorkspaceTrade({ accountId: 'paper-main', qty: 2 });
    expect(v1?.tickets['*']?.execute).toBe('chart');
    const kept = readWorkspaceTrade({ v: 2, tickets: { 'chart-1': { qty: 1, execute: 'micro' } }, oco: {} });
    expect(kept?.tickets['chart-1']?.execute).toBe('micro');
  });
});

describe('an NQ chart trading MNQ', () => {
  const chart = 'NQZ6.CME';
  const traded = tradedContract({
    accountId: 'paper-main',
    account: 'Paper (Tessera Paper)',
    wanted: { exchange: 'CME', root: 'MNQ', expiry: '2026-12' },
    instrument: { id: 'MNQZ6.CME' } as never,
    spec: MNQ,
    refused: null,
  }).instrument!;
  const math = mathOf(MNQ, traded)!;
  const tile = { layoutId: 'main', tileId: 'chart-1' };
  const q: PlaceQuote = { bid: 21000, ask: 21000.25, last: 21000 };

  it('a click by risk sends MNQ, sized in MNQ money, and never NQ', () => {
    expect(traded).toBe('MNQZ6.CME');
    expect(math.tickValue).toBe(0.5);
    const base = ticketPlaceBase({
      accountId: 'paper-main',
      environment: 'paper',
      contract: { instrument: traded, symbol: displaySymbol(traded), math },
      side: 'buy',
      kind: 'market',
      ticket: { qty: 1, sizing: 'risk', risk: 100 },
      stopTicks: null,
      targetTicks: null,
      tile,
    });
    const p = beginPlacement(base);
    expect(p.stage).toBe('stop');
    const step = placeAt(p, 20990.1, q, false);
    expect(step.kind).toBe('send');
    if (step.kind !== 'send') return;
    expect(step.input.instrument).toBe('MNQZ6.CME');
    expect(step.input.qty).toBe(4);
    expect(step.input.bracket?.stopLoss).toBe(20990);
    expect(step.what).toBe('Buy 4 MNQ Z6 at market');
    expect(JSON.stringify(step.input)).not.toContain('"NQZ6.CME"');

    const mnqIds = new Set([traded]);
    expect(placementFor(p, 'paper-main', mnqIds, tile)).toBe(p);
    expect(placementFor(p, 'paper-main', mnqIds, { layoutId: 'main', tileId: 'chart-2' })).toBeNull();
    expect(placementFor(p, 'paper-main', new Set([chart, 'NQ']), tile)).toBeNull();
  });

  it('the menu’s Trade at rows send MNQ', () => {
    const account = {
      account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper' },
      summary: { netLiq: { amount: 50_000, currency: 'USD' } },
      risk: null,
    } as unknown as AccountUpdate;
    const row = menuTrade({
      side: 'buy',
      kind: 'limit',
      price: 20990,
      quote: { bid: 21000, ask: 21000.25, last: 21000 },
      account,
      ticket: { sizing: 'qty', qty: 3 },
      math: chartMathOf(math, 2),
      instrument: traded,
    });
    expect(row?.input).toMatchObject({ instrument: 'MNQZ6.CME', qty: 3, limitPrice: 20990 });
  });

  it('its tags name MNQ, and the chart’s own NQ tags stay as they were', () => {
    const pal = bracketPalette(TOKENS);
    const opts = { fanned: null, preview: null };
    const position = (instrument: string, qty: number) => ({
      accountId: 'paper-main',
      instrument,
      qty,
      avgPrice: 21000,
      openedAt: 0,
      unrealizedPnl: { amount: 12, currency: 'USD' },
    });
    const positions = [position('MNQZ6.CME', 2), position('NQZ6.CME', 1)] as never;
    const mnq = groupBrackets([], positions, [], new Set([traded]));
    const nq = groupBrackets([], positions, [], new Set([chart]));
    expect(mnq.map((b) => b.instrument)).toEqual(['MNQZ6.CME']);
    const named = namedTags(bracketTags(mnq, chartMathOf(math, 2), pal, opts), 'MNQ');
    expect(named[0]?.text).toBe('MNQ · Long 2 · 21,000.00 · +$12.00');
    const own = namedTags(bracketTags(nq, chartMathOf(mathOf(NQ, chart), 2), pal, opts), null);
    expect(own[0]?.text).toBe('Long 1 · 21,000.00 · +$12.00');
  });
});
