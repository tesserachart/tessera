import type { AccountUpdate } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import type { ChartMath } from '../src/chart/brackets.ts';
import { menuTrade } from '../src/chart/menuTrade.ts';

const NQ = 'NQZ6.CME';
const math: ChartMath = { decimals: 2, tick: 0.25, multiplier: 20 };
const account = (locked = false): AccountUpdate =>
  ({
    account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper' },
    summary: { netLiq: { amount: 50_000, currency: 'USD' } },
    risk: null,
    ...(locked ? { limits: { locked: true, dailyLossLimit: { amount: 500 }, dailyLossLeft: { amount: 0 } } } : {}),
  }) as unknown as AccountUpdate;
const quote = { bid: 20649.75, ask: 20650, last: 20650 };
const row = (over: Partial<Parameters<typeof menuTrade>[0]> = {}) => {
  const r = menuTrade({
    side: 'sell',
    kind: 'limit',
    price: 20709.5,
    quote,
    account: account(),
    ticket: { sizing: 'qty', qty: 1 },
    math,
    instrument: NQ,
    ...over,
  });
  if (!r) throw new Error('no row');
  return r;
};

describe('the chart menu’s Trade at rows', () => {
  it('places a plain order: no stop, no target', () => {
    const r = row({ ticket: { sizing: 'qty', qty: 2 } });
    expect(r.word).toBe('Sell limit 2 @ 20,709.50');
    expect(r.hint).toBe('no bracket');
    expect(r.input).toMatchObject({ qty: 2, orderType: 'limit', limitPrice: 20709.5, side: 'sell' });
    expect(r.input?.bracket ?? null).toBeNull();
  });

  it('by contracts, the row says the quantity typed', () => {
    const r = row({ side: 'buy', price: 20600, ticket: { sizing: 'qty', qty: 4 } });
    expect(r.input).toMatchObject({ qty: 4, orderType: 'limit', limitPrice: 20600, side: 'buy' });
    expect(r.word).toBe('Buy limit 4 @ 20,600.00');
  });

  it('by risk, a plain order has no stop to size from, so the row names no amount and says why', () => {
    const r = row({ ticket: { sizing: 'risk', qty: 4 } });
    expect(r.input).toBeNull();
    expect(r.word).toBe('Sell limit @ 20,709.50');
    expect(r.reason).toBe('Sizing by risk needs a stop; the menu places a plain order');
  });

  it('offers each kind as itself: a limit through the market at the touch, a stop through it not at all', () => {
    const at = (side: 'buy' | 'sell', kind: 'limit' | 'stop', price: number) =>
      menuTrade({
        side,
        kind,
        price,
        quote,
        account: account(),
        ticket: { sizing: 'qty', qty: 1 },
        math,
        instrument: NQ,
      });
    expect(at('buy', 'stop', 20700)?.input).toMatchObject({ orderType: 'stop', stopPrice: 20700 });
    expect(at('sell', 'stop', 20700)).toBeNull();
    const buyLimit = at('buy', 'limit', 20700);
    expect(buyLimit?.word).toBe('Buy limit 1 @ ask 20,650.00');
    expect(buyLimit?.input).toMatchObject({ orderType: 'limit', limitPrice: 20650 });
    expect(buyLimit?.input?.bracket ?? null).toBeNull();
    expect(at('sell', 'stop', 20600)?.input).toMatchObject({ orderType: 'stop', stopPrice: 20600 });
  });

  it('sends nothing without an account, a price, or room to trade', () => {
    expect(row({ account: null })).toMatchObject({ input: null, reason: 'No trading account' });
    expect(row({ quote: { bid: null, ask: null, last: null } })).toMatchObject({ input: null, reason: 'No price yet' });
    expect(row({ account: account(true) })).toMatchObject({
      input: null,
      reason: 'Daily loss limit reached · exits work',
    });
  });
});
